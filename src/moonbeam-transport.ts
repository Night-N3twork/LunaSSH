/**
 * MoonbeamTransport — SSH over Moonbeam relay (MessagePort → Wisp)
 *
 * Mirrors Nova's MessagePortTransport pattern: speak raw Wisp packets
 * over a MessagePort obtained from `MoonbeamRelay.attach()`.
 * The relay owns the upstream WispClient; we just tunnel one TCP
 * stream (the SSH connection) through it.
 *
 * Protocol: each postMessage carries exactly one Wisp packet
 * (ArrayBuffer) — same wire format as Nova's MessagePortTransport.
 */

import {
  encodePacket,
  decodePacket,
  encodeConnect,
  encodeClose,
  encodeContinue,
  decodeContinue,
  decodeClose,
} from '@nightnetwork/moonbeam';
import { PACKET_TYPE, CLOSE_REASON, RESERVED_STREAM_ID } from '@nightnetwork/moonbeam';
import { WispTransportCloseError, type WasmTransport } from './bridge';

export interface MoonbeamTransportOptions {
  sshHost: string;
  sshPort: number;
  /** Stream ID to use (default 1). Must not be 0 (reserved). */
  streamId?: number;
}

export class MoonbeamTransport implements WasmTransport {
  public id: string;
  public onData?: (data: Uint8Array) => void;
  public onError?: (error: Error) => void;
  public onClose?: (error?: Error) => void;

  private relay: any;
  private port: MessagePort | null = null;
  private opts: MoonbeamTransportOptions;
  private streamId: number;
  private connected = false;
  private closed = false;

  // TCP flow-control mirroring WispClient's credit tracking.
  private creditsRemaining = 0;
  private sendQueue: { data: Uint8Array; resolve: () => void; reject: (error: Error) => void }[] = [];
  private pendingOpen = true;
  private resolveOpen: (() => void) | null = null;
  private rejectOpen: ((error: Error) => void) | null = null;

  constructor(id: string, relay: any, opts: MoonbeamTransportOptions) {
    this.id = id;
    this.relay = relay;
    this.opts = opts;
    this.streamId = opts.streamId ?? 1;
    if (this.streamId === RESERVED_STREAM_ID) throw new Error('MoonbeamTransport: streamId 0 is reserved');
  }

  async connect(): Promise<void> {
    if (this.port) throw new Error('MoonbeamTransport: already connected');
    if (!this.relay || typeof this.relay.attach !== 'function') {
      throw new Error('MoonbeamTransport: relay must expose attach() -> MessagePort');
    }

    this.pendingOpen = true;
    this.creditsRemaining = 0;
    this.sendQueue = [];
    this.closed = false;
    this.connected = false;

    this.port = this.relay.attach({ label: this.id }) as MessagePort;
    this.port.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    // Some MessagePort impls need start() — Moonbeam's relay calls port1.start() but we start our side too.
    try {
      (this.port as any).start?.();
    } catch {}

    const opening = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });

    // MoonbeamRelay sends an immediate CONTINUE on stream 0 (CLIENT_HANDSHAKE_CREDIT=0)
    // to complete the client's v1 handshake. We wait a tick so that message is consumed,
    // then send our CONNECT for the SSH stream.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const connectPayload = encodeConnect('tcp', this.opts.sshPort, this.opts.sshHost);
    const connectPkt = encodePacket(PACKET_TYPE.CONNECT, this.streamId, connectPayload);
    this.postPacket(connectPkt);

    // Opening is confirmed only by a stream-level CONTINUE granting its initial window.
    await opening;

    this.connected = true;
    this.closed = false;
  }

  private handleMessage(raw: any): void {
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    const pkt = decodePacket(buf);
    if (!pkt) return;

    // Stream 0 packets are relay handshake only — ignore except for error close
    if (pkt.streamId === RESERVED_STREAM_ID) {
      if (pkt.type === PACKET_TYPE.CLOSE) {
        this.closed = true;
        this.connected = false;
        this.onClose?.();
      }
      return;
    }

    if (pkt.streamId !== this.streamId) return;

    switch (pkt.type) {
      case PACKET_TYPE.DATA: {
        this.onData?.(new Uint8Array(pkt.payload));
        break;
      }
      case PACKET_TYPE.CONTINUE: {
        const credits = decodeContinue(pkt.payload);
        if (credits == null) return;
        this.creditsRemaining = credits;
        if (this.pendingOpen) {
          this.pendingOpen = false;
          this.resolveOpen?.();
          this.resolveOpen = null;
          this.rejectOpen = null;
        }
        this.drainSendQueue();
        break;
      }
      case PACKET_TYPE.CLOSE: {
        const reason = decodeClose(pkt.payload);
        const error = reason == null ? undefined : new WispTransportCloseError(reason);
        this.closed = true;
        this.connected = false;
        this.rejectPending(error ?? new Error('MoonbeamTransport: stream closed'));
        try {
          this.port?.close();
        } catch {}
        this.port = null;
        this.onClose?.(error);
        break;
      }
      default:
        // INFO etc — ignore
        break;
    }
  }

  private postPacket(pkt: Uint8Array): boolean {
    if (!this.port) return false;
    // Transfer ArrayBuffer ownership — matches MoonbeamRelay's postMessage(pkt.buffer, [pkt.buffer])
    const buf = pkt.buffer as ArrayBuffer;
    try {
      this.port.postMessage(buf, [buf]);
      return true;
    } catch {
      // Fallback if transfer fails (e.g. detached)
      try {
        this.port.postMessage(pkt);
        return true;
      } catch {
        return false;
      }
    }
  }

  private drainSendQueue(): void {
    while (this.sendQueue.length > 0 && this.creditsRemaining > 0) {
      const send = this.sendQueue.shift()!;
      if (!this.postPacket(encodePacket(PACKET_TYPE.DATA, this.streamId, send.data))) {
        send.reject(new Error('MoonbeamTransport: failed to send'));
        continue;
      }
      this.creditsRemaining--;
      send.resolve();
    }
  }

  private rejectPending(error: Error): void {
    this.rejectOpen?.(error);
    this.resolveOpen = null;
    this.rejectOpen = null;
    for (const send of this.sendQueue) send.reject(error);
    this.sendQueue = [];
    this.pendingOpen = true;
    this.creditsRemaining = 0;
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('MoonbeamTransport: closed');
    if (!this.port || !this.connected) throw new Error('MoonbeamTransport: not connected — call connect() first');

    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push({ data, resolve, reject });
      this.drainSendQueue();
    });
  }

  async disconnect(): Promise<void> {
    if (this.closed && !this.port) return;
    this.closed = true;
    this.connected = false;
    if (this.port) {
      try {
        const pkt = encodePacket(PACKET_TYPE.CLOSE, this.streamId, encodeClose(CLOSE_REASON.VOLUNTARY));
        this.postPacket(pkt);
      } catch {}
      try {
        this.port.close();
      } catch {}
      this.port = null;
    }
    this.rejectPending(new Error('MoonbeamTransport: closed'));
    this.onClose?.();
  }

  get isConnected(): boolean {
    return this.connected && !this.closed;
  }
}
