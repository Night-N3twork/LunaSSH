import { describe, it, expect, vi } from 'vitest';
import { MoonbeamTransport } from '../../src/moonbeam-transport';
import { MockMoonbeamRelay, FailingRelay } from '../helpers/mock-moonbeam-relay';
import { decodePacket, encodeClose, encodeContinue, encodePacket } from '@nightnetwork/moonbeam';
import { CLOSE_REASON, PACKET_TYPE } from '@nightnetwork/moonbeam';

class CreditControlledRelay {
  attachment?: { port: MessagePort; dataPackets: Uint8Array[] };

  attach(): MessagePort {
    const channel = new MessageChannel();
    const port = channel.port1;
    this.attachment = { port, dataPackets: [] };
    port.onmessage = (event: MessageEvent) => {
      const packet = decodePacket(new Uint8Array(event.data as ArrayBuffer));
      if (packet?.type === PACKET_TYPE.DATA) this.attachment!.dataPackets.push(packet.payload);
    };
    port.start();
    channel.port2.start();
    return channel.port2;
  }

  grant(streamId = 1, credits = 1): void {
    const packet = encodePacket(PACKET_TYPE.CONTINUE, streamId, encodeContinue(credits));
    this.attachment!.port.postMessage(packet.buffer as ArrayBuffer, [packet.buffer as ArrayBuffer]);
  }

  close(streamId = 1): void {
    const packet = encodePacket(PACKET_TYPE.CLOSE, streamId, encodeClose(CLOSE_REASON.VOLUNTARY));
    this.attachment!.port.postMessage(packet.buffer as ArrayBuffer, [packet.buffer as ArrayBuffer]);
  }
}

describe('MoonbeamTransport', () => {
  it('exposes Transport interface', () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    expect(t.id).toBe('id1');
    expect(typeof t.connect).toBe('function');
    expect(typeof t.send).toBe('function');
    expect(typeof t.disconnect).toBe('function');
  });

  it('throws for reserved streamId 0', () => {
    const relay = new MockMoonbeamRelay();
    expect(() => new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22, streamId: 0 })).toThrow(/reserved/);
  });

  it('throws if relay missing attach', async () => {
    const t = new MoonbeamTransport('id1', {} as any, { sshHost: '1.1.1.1', sshPort: 22 });
    await expect(t.connect()).rejects.toThrow(/attach/);
  });

  it('does not open without initial stream credit', async () => {
    vi.useFakeTimers();
    try {
      const relay = new CreditControlledRelay();
      const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
      const opening = t.connect();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.isConnected).toBe(false);

      relay.close();
      await expect(opening).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for credit before resolving a send', async () => {
    const relay = new CreditControlledRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    const opening = t.connect();
    relay.grant();
    await opening;

    await t.send(new Uint8Array([0]));
    const sending = t.send(new Uint8Array([1, 2, 3]));
    let settled = false;
    void sending.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(relay.attachment!.dataPackets.map(packet => Array.from(packet))).toEqual([[0]]);

    relay.grant();
    await sending;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(relay.attachment!.dataPackets.map(packet => Array.from(packet))).toEqual([[0], [1, 2, 3]]);
    await t.disconnect();
  });

  it('rejects queued sends when the relay closes', async () => {
    const relay = new CreditControlledRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    const opening = t.connect();
    relay.grant();
    await opening;

    await t.send(new Uint8Array([0]));
    const sending = t.send(new Uint8Array([1]));
    relay.close();
    await expect(sending).rejects.toThrow(/closed/);
  });

  it('connect creates MessagePort and waits for CONTINUE', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    expect(t.isConnected).toBe(true);
    expect(relay.clientCount).toBe(1);
    await t.disconnect();
    expect(t.isConnected).toBe(false);
  });

  it('throws if already connected', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await expect(t.connect()).rejects.toThrow(/already connected/);
    await t.disconnect();
  });

  it('send after connect posts DATA and onData receives echo', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    const received: Uint8Array[] = [];
    t.onData = (d) => received.push(d);
    await t.send(new Uint8Array([1,2,3]));
    // wait for mock relay echo (async)
    await new Promise(r => setTimeout(r, 20));
    expect(received.length).toBe(1);
    expect(Array.from(received[0])).toEqual([1,2,3]);
    await t.disconnect();
  });

  it('send throws if not connected', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/not connected/);
  });

  it('send throws if closed', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await t.disconnect();
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/closed/);
  });

  it('resolves queued sends after CONTINUE drains them', async () => {
    const relay = new MockMoonbeamRelay();
    // Use a relay that delays CONTINUE to test queue
    // Our mock always sends CONTINUE quickly, so just test queue logic still works
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    // Force pendingOpen false and credits 0 to test queue
    (t as any).creditsRemaining = 0;
    (t as any).pendingOpen = false;
    t.onData = () => {};
    const sending = t.send(new Uint8Array([9]));
    expect((t as any).sendQueue.length).toBe(1);
    (t as any).handleMessage(encodePacket(PACKET_TYPE.CONTINUE, 1, encodeContinue(1)));
    await sending;
    expect(t.isConnected).toBe(true);
    await t.disconnect();
  });

  it('disconnect is idempotent', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await t.disconnect();
    await expect(t.disconnect()).resolves.toBeUndefined();
  });

  it('resets flow-control state before reconnecting', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await t.disconnect();
    (t as any).pendingOpen = false;
    (t as any).creditsRemaining = 99;
    (t as any).sendQueue = [new Uint8Array([1])];

    const reconnect = t.connect();
    expect((t as any).pendingOpen).toBe(true);
    expect((t as any).creditsRemaining).toBe(0);
    expect((t as any).sendQueue).toEqual([]);
    await reconnect;
    await t.disconnect();
  });

  it('onClose fires on disconnect', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    let closed = false;
    t.onClose = () => { closed = true; };
    await t.disconnect();
    expect(closed).toBe(true);
  });

  it('clears the peer-closed port so the transport can reconnect', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    let closed = false;
    t.onClose = () => { closed = true; };
    // Simulate server closing stream by sending CLOSE via relay's port
    const attachment = relay.attachments[0];
    const { encodePacket, encodeClose } = await import('@nightnetwork/moonbeam');
    const { PACKET_TYPE } = await import('@nightnetwork/moonbeam');
    const pkt = encodePacket(PACKET_TYPE.CLOSE, 1, encodeClose(2));
    attachment.port.postMessage(pkt.buffer as ArrayBuffer, [pkt.buffer as ArrayBuffer]);
    await new Promise(r => setTimeout(r, 10));
    expect(closed).toBe(true);
    expect((t as any).port).toBeNull();
    await t.connect();
    expect(t.isConnected).toBe(true);
    expect(relay.clientCount).toBe(2);
    await t.disconnect();
  });

  it('reports a target Wisp close reason without exposing packet payloads', async () => {
    const relay = new MockMoonbeamRelay();
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    const close = new Promise<Error | undefined>((resolve) => {
      t.onClose = (error) => resolve(error);
    });

    const payload = new Uint8Array([CLOSE_REASON.STREAM_UNREACHABLE, ...new TextEncoder().encode('password=do-not-leak')]);
    const packet = encodePacket(PACKET_TYPE.CLOSE, 1, payload);
    relay.attachments[0].port.postMessage(packet.buffer as ArrayBuffer, [packet.buffer as ArrayBuffer]);

    await expect(close).resolves.toMatchObject({
      name: 'WispTransportCloseError',
      reason: CLOSE_REASON.STREAM_UNREACHABLE,
      message: 'Wisp transport closed: STREAM_UNREACHABLE (0x42)',
    });
  });

  it('fails gracefully when relay attach throws', async () => {
    const relay = new FailingRelay() as any;
    const t = new MoonbeamTransport('id1', relay, { sshHost: '1.1.1.1', sshPort: 22 });
    await expect(t.connect()).rejects.toThrow(/attach failed/);
  });
});
