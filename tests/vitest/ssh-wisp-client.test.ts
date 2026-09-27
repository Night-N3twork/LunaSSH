import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SSHWispClient } from '../../src/ssh-wisp-client';

// Mock SSHClient
vi.mock('../../src/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/client')>('../../src/client');
  return {
    ...actual,
    SSHClient: {
      connect: vi.fn(async (opts, transport, cbs) => {
        // Simulate that connect will call transport.connect()
        await transport.connect?.();
        return {
          sessionId: 'mock-session',
          send: vi.fn(async () => {}),
          disconnect: vi.fn(async () => {}),
          resizeTerminal: vi.fn(async () => {}),
        };
      }),
      initialize: vi.fn(async () => {}),
    },
  };
});

// Also need to mock transports to avoid real network
vi.mock('../../src/wisp-transport', () => {
  return {
    WispTransport: vi.fn(function (this: any, id: string, opts: any) {
      this.id = id;
      this.opts = opts;
      this.connect = vi.fn(async () => {});
      this.disconnect = vi.fn(async () => {});
      this.send = vi.fn(async () => {});
    }),
  };
});

vi.mock('../../src/moonbeam-transport', () => {
  return {
    MoonbeamTransport: vi.fn(function (this: any, id: string, relay: any, opts: any) {
      this.id = id;
      this.relay = relay;
      this.opts = opts;
      this.connect = vi.fn(async () => {});
      this.disconnect = vi.fn(async () => {});
      this.send = vi.fn(async () => {});
    }),
  };
});

import { SSHClient } from '../../src/client';
import { WispTransport } from '../../src/wisp-transport';
import { MoonbeamTransport } from '../../src/moonbeam-transport';

describe('SSHWispClient', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes helpers', () => {
    expect(typeof SSHWispClient.connectViaWisp).toBe('function');
    expect(typeof SSHWispClient.connectViaMoonbeam).toBe('function');
    expect(typeof SSHWispClient.createWispTransport).toBe('function');
    expect(typeof SSHWispClient.createMoonbeamTransport).toBe('function');
  });

  it('connectViaWisp throws if wispUrl missing', async () => {
    await expect(SSHWispClient.connectViaWisp({ host: '1.1.1.1', port: 22, user: 'test' } as any)).rejects.toThrow(/wispUrl/);
  });

  it('connectViaWisp creates WispTransport and calls SSHClient.connect', async () => {
    const sess = await SSHWispClient.connectViaWisp({
      host: '203.0.113.1', port: 22, user: 'root', password: 'pw', wispUrl: 'wss://wisp.example.com/',
    });
    expect(WispTransport).toHaveBeenCalled();
    const ctorArgs = (WispTransport as any).mock.calls[0];
    expect(ctorArgs[1].wispUrl).toBe('wss://wisp.example.com/');
    expect(ctorArgs[1].sshHost).toBe('203.0.113.1');
    expect(ctorArgs[1].sshPort).toBe(22);
    expect(SSHClient.connect).toHaveBeenCalled();
    expect(sess.sessionId).toBe('mock-session');
  });

  it('connectViaWisp forwards wispConfig', async () => {
    await SSHWispClient.connectViaWisp({
      host: '1.1.1.1', port: 22, user: 'u', wispUrl: 'wss://x/', wispConfig: { handshakeTimeoutMs: 5000 } as any,
    });
    const opts = (WispTransport as any).mock.calls[0][1];
    expect(opts.wispConfig.handshakeTimeoutMs).toBe(5000);
  });

  it('connectViaMoonbeam throws if relay invalid', async () => {
    await expect(SSHWispClient.connectViaMoonbeam({ host: '1.1.1.1', port: 22, user: 'u' }, {} as any)).rejects.toThrow(/relay/);
    await expect(SSHWispClient.connectViaMoonbeam({ host: '1.1.1.1', port: 22, user: 'u' }, null as any)).rejects.toThrow(/relay/);
  });

  it('connectViaMoonbeam creates MoonbeamTransport and calls SSHClient.connect', async () => {
    const fakeRelay = { attach: () => new MessageChannel().port1, clientCount: () => 0 };
    const sess = await SSHWispClient.connectViaMoonbeam({ host: '1.1.1.1', port: 22, user: 'u' }, fakeRelay as any);
    expect(MoonbeamTransport).toHaveBeenCalled();
    const args = (MoonbeamTransport as any).mock.calls[0];
    expect(args[2].sshHost).toBe('1.1.1.1');
    expect(args[2].sshPort).toBe(22);
    expect(SSHClient.connect).toHaveBeenCalled();
    expect(sess.sessionId).toBe('mock-session');
  });

  it('createWispTransport returns instance', () => {
    const t = SSHWispClient.createWispTransport('id1', { wispUrl: 'wss://x/', sshHost: '1.1.1.1', sshPort: 22 });
    expect(t).toBeDefined();
    expect((t as any).id).toBe('id1');
  });

  it('createMoonbeamTransport returns instance', () => {
    const fakeRelay = { attach: () => new MessageChannel().port1 };
    const t = SSHWispClient.createMoonbeamTransport('id1', fakeRelay as any, { sshHost: '1.1.1.1', sshPort: 22 });
    expect(t).toBeDefined();
    expect((t as any).id).toBe('id1');
  });

  it('passes callbacks through to SSHClient.connect', async () => {
    const cbs = { onPacketReceive: vi.fn(), onStateChange: vi.fn() };
    await SSHWispClient.connectViaWisp({
      host: '1.1.1.1', port: 22, user: 'u', wispUrl: 'wss://x/',
    }, cbs as any);
    const connectCall = (SSHClient.connect as any).mock.calls[0];
    expect(connectCall[2]).toBe(cbs);
  });

  it('connectViaProvider passes the SSH auth banner callback through without reclassifying failures', async () => {
    const onAuthBanner = vi.fn();
    const cause = new Error('SSH authentication rejected');
    const provider = { dialTcp: vi.fn() };
    vi.mocked(SSHClient.connect).mockImplementationOnce(async (_opts, _transport, callbacks) => {
      callbacks?.onAuthBanner?.('Visit https://login.tailscale.com/a/check\r\n');
      throw cause;
    });

    await expect(SSHWispClient.connectViaProvider(
      { host: '100.64.0.1', port: 22, user: 'alice' }, provider, { onAuthBanner },
    )).rejects.toBe(cause);
    expect(onAuthBanner).toHaveBeenCalledExactlyOnceWith('Visit https://login.tailscale.com/a/check\r\n');
  });

  it('does not treat provider authorization URLs as SSH auth banners', async () => {
    const cause = new Error('SSH connection rejected');
    const provider = {
      dialTcp: vi.fn(),
      onAuthorizationURL: vi.fn(),
    };
    vi.mocked(SSHClient.connect).mockImplementationOnce(async () => {
      throw cause;
    });

    const error = await SSHWispClient.connectViaProvider(
      { host: '100.64.0.1', port: 22, user: 'root' },
      provider,
    ).catch((error: unknown) => error);

    expect(error).toBe(cause);
    expect(provider.onAuthorizationURL).not.toHaveBeenCalled();
  });

  it('passes through ordinary provider connection errors unchanged', async () => {
    const cause = new Error('network unavailable');
    const provider = { dialTcp: vi.fn() };
    vi.mocked(SSHClient.connect).mockRejectedValueOnce(cause);

    const error = await SSHWispClient.connectViaProvider(
      { host: '100.64.0.1', port: 22, user: 'root' },
      provider,
    ).catch((error: unknown) => error);

    expect(error).toBe(cause);
  });

  it('forwards provider cancellation options as the fourth connect argument', async () => {
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const provider = { dialTcp: vi.fn(async () => ({ on: vi.fn(() => vi.fn()), send: vi.fn(), close: vi.fn() })) };
    const connection = { host: 'ssh.example', port: 22, user: 'alice' };

    await SSHWispClient.connectViaProvider(connection, provider, undefined, options);
    expect(SSHClient.connect).toHaveBeenCalledWith(connection, expect.anything(), undefined, options);
  });

  it.each(['wisp', 'moonbeam'] as const)('forwards %s cancellation options to SSHClient.connect', async (kind) => {
    const options = { signal: new AbortController().signal };
    const connection = { host: 'ssh.example', port: 22, user: 'alice' };
    if (kind === 'wisp') {
      await SSHWispClient.connectViaWisp({ ...connection, wispUrl: 'wss://wisp.example/' }, undefined, options);
    } else {
      await SSHWispClient.connectViaMoonbeam(connection, { attach: vi.fn() }, undefined, options);
    }
    expect(SSHClient.connect).toHaveBeenCalledWith(connection, expect.anything(), undefined, options);
  });

});
