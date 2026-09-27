import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WispTransport } from '../../src/wisp-transport';
import { MockWebSocket } from '../helpers/mock-websocket';
import { MockWispServer } from '../helpers/mock-wisp-server';
import { encodePacket } from '@nightnetwork/moonbeam';
import { PACKET_TYPE } from '@nightnetwork/moonbeam';

function makeWispTransportPair(sshHost = '203.0.113.1', sshPort = 22) {
  const ws = new MockWebSocket();
  const srv = new MockWispServer(ws);
  // We will inject MockWebSocket via WispClient's _injectWebSocket by patching WispTransport to use it.
  // Instead of constructing WispTransport normally (which creates real WispClient with url),
  // we create a transport and then monkey-patch its internal creation.
  // Simpler: construct WispTransport but intercept WispClient construction via mocking.
  // Let's instead directly test via creating a WispTransport with a known mock ws injected through wispConfig? 
  // Our WispTransport currently doesn't expose _injectWebSocket; we will test via integration by relying on
  // the fact that WispTransport creates WispClient with {url, _injectWebSocket} if we pass it via wispConfig.
  // But our WispTransport type doesn't include _injectWebSocket; we cast.
  const transport = new WispTransport('test-wisp', {
    wispUrl: 'wss://wisp.example.com/',
    sshHost,
    sshPort,
    wispConfig: { handshakeTimeoutMs: 1000, allowV1: true } as any,
  });
  // Inject mock websocket by patching the WispClient constructor call.
  // We'll replace the private client creation: after connect starts, it will create WispClient.
  // To inject our mock, we set a property that WispTransport checks — but it doesn't currently.
  // So we directly mock the @nightnetwork/moonbeam module before import.
  // Alternative approach: test via manual WispClient flow without WispTransport's internal details.
  // For now, we test WispTransport interface and mocked connect.
  return { ws, srv, transport };
}

let neverConfirmOpen = false;
const fakeClients: any[] = [];

// Mock @nightnetwork/moonbeam's WispClient for deterministic tests
vi.mock('@nightnetwork/moonbeam', async () => {
  const actual = await vi.importActual<typeof import('@nightnetwork/moonbeam')>('@nightnetwork/moonbeam');
  // Keep actual encode/decode but mock WispClient
  class FakeWispStream {
    id = 1;
    private dataCbs: ((d: Uint8Array)=>void)[] = [];
    private closeCbs: (()=>void)[] = [];
    private openCbs: (()=>void)[] = [];
    pendingOpen = false;
    constructor(public host: string, public port: number) {
      // Simulate async open after creation
      this.pendingOpen = neverConfirmOpen;
      if (!neverConfirmOpen) setTimeout(() => {
        this.pendingOpen = false;
        this.openCbs.forEach(cb => cb());
      }, 0);
    }
    on(event: string, cb: any) {
      if (event === 'data') this.dataCbs.push(cb);
      if (event === 'close') this.closeCbs.push(cb);
      if (event === 'open') this.openCbs.push(cb);
      if (event === 'error') {} // ignore
    }
    send(data: Uint8Array) {
      // echo not needed; just store
      (this as any).lastSent = data;
    }
    close() {
      (this as any).closeCalls = ((this as any).closeCalls ?? 0) + 1;
      this.closeCbs.forEach(cb => cb());
    }
    // helper to simulate incoming data
    simulateData(data: Uint8Array) {
      this.dataCbs.forEach(cb => cb(data));
    }
    simulateClose() {
      this.closeCbs.forEach(cb => cb());
    }
  }

  class FakeWispClient {
    connected = true;
    confirmStreamOpen = neverConfirmOpen;
    streams: FakeWispStream[] = [];
    private closeCbs: (()=>void)[] = [];
    private errorCbs: ((e:any)=>void)[] = [];
    constructor(opts: any) {
      // Immediately "connected"
      fakeClients.push(this);
    }
    async ready() {}
    createStream(host: string, port: number, type: string) {
      const stream = new FakeWispStream(host, port);
      this.streams.push(stream);
      return stream as any;
    }
    on(event: string, cb: any) {
      if (event === 'close') this.closeCbs.push(cb);
      if (event === 'error') this.errorCbs.push(cb);
    }
    close() { this.connected = false; this.closeCbs.forEach(cb=>cb()); }
  }

  return { ...actual, WispClient: FakeWispClient };
});

describe('WispTransport', () => {
  beforeEach(() => {
    neverConfirmOpen = false;
    fakeClients.length = 0;
    vi.useRealTimers();
  });
  it('exposes Transport interface', () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://wisp.example.com/', sshHost: '1.1.1.1', sshPort: 22 });
    expect(t.id).toBe('id1');
    expect(typeof t.connect).toBe('function');
    expect(typeof t.send).toBe('function');
    expect(typeof t.disconnect).toBe('function');
  });

  it('throws if already connected', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await expect(t.connect()).rejects.toThrow(/already connected/);
    await t.disconnect();
  });

  it('connect creates stream and send works', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    expect(t.isConnected).toBe(true);
    await expect(t.send(new Uint8Array([1,2,3]))).resolves.toBeUndefined();
    await t.disconnect();
    expect(t.isConnected).toBe(false);
  });

  it('send throws if not connected', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/not connected/);
  });

  it('send throws if closed', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await t.disconnect();
    await expect(t.send(new Uint8Array([1]))).rejects.toThrow(/closed/);
  });

  it('onData fires when stream receives data', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    const received: Uint8Array[] = [];
    t.onData = (d) => received.push(d);
    // Access private stream to simulate data
    const stream: any = (t as any).stream;
    stream.simulateData(new Uint8Array([9,9,9]));
    expect(received.length).toBe(1);
    expect(Array.from(received[0])).toEqual([9,9,9]);
    await t.disconnect();
  });

  it('onClose fires when stream closes', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    let closed = false;
    t.onClose = () => { closed = true; };
    const stream: any = (t as any).stream;
    stream.simulateClose();
    expect(closed).toBe(true);
  });

  it('disconnect is idempotent', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    await t.disconnect();
    await expect(t.disconnect()).resolves.toBeUndefined();
    await expect(t.disconnect()).resolves.toBeUndefined();
  });

  it('clears peer-closed Wisp state and reconnects without duplicate close callbacks', async () => {
    const t = new WispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    await t.connect();
    let closeCount = 0;
    t.onClose = () => { closeCount++; };
    const firstClient: any = (t as any).client;
    firstClient.close();

    expect(closeCount).toBe(1);
    expect((t as any).stream).toBeNull();
    expect((t as any).client).toBeNull();
    await t.connect();
    expect((t as any).client).not.toBe(firstClient);
    expect(closeCount).toBe(1);
    await t.disconnect();
  });

  it('times out a stalled confirmed stream and cleans up the Wisp client and stream', async () => {
    vi.useFakeTimers();
    neverConfirmOpen = true;
    const t = new WispTransport('stalled', {
      wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22, connectionTimeoutMs: 25,
    });
    const errors: Error[] = [];
    t.onError = (error) => errors.push(error);
    const connecting = t.connect();
    const rejected = expect(connecting).rejects.toThrow(/stream open timed out/i);

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(errors[0]?.message).toMatch(/stream open timed out/i);
    expect((t as any).client).toBeNull();
    expect((t as any).stream).toBeNull();
    expect(fakeClients[0].connected).toBe(false);
    expect((fakeClients[0].streams[0] as any).closeCalls).toBe(1);
  });
});
