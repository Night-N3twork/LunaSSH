/**
 * WispTransport — SSH over Wisp v2.1
 *
 * Carries a raw SSH TCP stream over a shared Wisp WebSocket.
 * multiplex a single logical TCP stream (host:port) over a shared
 * Wisp WebSocket. Backed by @nightnetwork/moonbeam's WispClient.
 *
 * Data flow: Go SSH bytes -> Transport.send() -> Wisp stream DATA -> Wisp server -> TCP -> sshd
 *            Wisp stream DATA -> onData -> injectTransportData -> Go SSH
 */

import { WispClient, type WispStream } from '@nightnetwork/moonbeam';
import type { WasmTransport } from './bridge';

export interface WispTransportOptions {
  /** Wisp server URL, e.g. wss://wisp.example.com/ */
  wispUrl: string;
  /** Destination SSH host (resolved by the wisp server) */
  sshHost: string;
  /** Destination SSH port */
  sshPort: number;
  /** Bounded TCP/SSH connection budget, including confirmed stream opening. */
  connectionTimeoutMs?: number;
  /** Optional WispClient tuning */
  wispConfig?: {
    allowV1?: boolean;
    handshakeTimeoutMs?: number;
    auth?: { username: string; password: string };
    initialBufferSize?: number;
  };
}

export class WispTransport implements WasmTransport {
  public id: string;
  public onData?: (data: Uint8Array) => void;
  public onError?: (error: Error) => void;
  public onClose?: () => void;

  private opts: WispTransportOptions;
  private client: WispClient | null = null;
  private stream: WispStream | null = null;
  private closed = false;

  constructor(id: string, opts: WispTransportOptions) {
    this.id = id;
    this.opts = opts;
  }

  private handlePeerClose(): void {
    if (this.closed) return;

    this.closed = true;
    const stream = this.stream;
    const client = this.client;
    this.stream = null;
    this.client = null;
    try {
      stream?.close();
    } catch {}
    try {
      client?.close();
    } catch {}
    this.onClose?.();
  }

  async connect(): Promise<void> {
    if (this.client || this.stream) throw new Error('WispTransport: already connected');
    this.closed = false;

    this.client = new WispClient({
      url: this.opts.wispUrl,
      allowV1: this.opts.wispConfig?.allowV1,
      handshakeTimeoutMs: this.opts.wispConfig?.handshakeTimeoutMs,
      auth: this.opts.wispConfig?.auth,
      initialBufferSize: this.opts.wispConfig?.initialBufferSize,
    } as any);

    try {
      await this.client.ready();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.onError?.(err);
      throw err;
    }

    this.stream = this.client.createStream(this.opts.sshHost, this.opts.sshPort, 'tcp');

    this.stream.on('data', (chunk: Uint8Array) => {
      this.onData?.(new Uint8Array(chunk));
    });

    this.stream.on('close', () => {
      this.handlePeerClose();
    });

    this.stream.on('error', (err: any) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    // Mirror WispClient close -> onClose for all streams
    this.client.on('close', () => {
      this.handlePeerClose();
    });
    this.client.on('error', (err: any) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    // Wait for the stream to be confirmed open if server requires it.
    // Otherwise a microtask ensures listeners are attached before first send.
    if (this.client.confirmStreamOpen) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = this.stream!;
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`WispTransport: stream open timed out after ${this.opts.connectionTimeoutMs ?? 30_000}ms`));
          }, this.opts.connectionTimeoutMs ?? 30_000);
          const onOpen = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            s.on('close', () => {});
            resolve();
          };
          const onClose = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(new Error('WispTransport: stream closed before open'));
          };
          s.on('open', onOpen);
          s.on('close', onClose);
          // Fallback: if stream already opened synchronously
          queueMicrotask(() => {
            if (!settled && !(s as any).pendingOpen) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
          });
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.onError?.(err);
        await this.disconnect();
        throw err;
      }
    } else {
      // Let the microtask that fires 'open' run, but don't block long.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('WispTransport: closed');
    if (!this.stream) throw new Error('WispTransport: not connected — call connect() first');
    this.stream.send(data);
  }

  async disconnect(): Promise<void> {
    if (this.closed && !this.client && !this.stream) return;
    this.closed = true;
    try {
      this.stream?.close();
    } catch {}
    this.stream = null;
    try {
      this.client?.close();
    } catch {}
    this.client = null;
    this.onClose?.();
  }

  get isConnected(): boolean {
    return !!this.stream && !this.closed && !!this.client?.connected;
  }
}
