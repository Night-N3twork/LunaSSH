import { afterEach, describe, it, expect, vi } from 'vitest';
import { LunaSSHHelpers, SSHClient } from '../../src/client';
import { wasmTransportManager } from '../../src/bridge';
import { WispTransport } from '../../src/wisp-transport';
import { ProviderTransport } from '../../src/provider-transport';

afterEach(() => {
  vi.restoreAllMocks();
  (SSHClient as any).initialized = false;
  (SSHClient as any).wasmInstance = undefined;
  (SSHClient as any).initialization = undefined;
  (wasmTransportManager as any).transports.clear();
  vi.unstubAllGlobals();
  delete (globalThis as any).Go;
  delete (globalThis as any).SSHClient;
});

describe('LunaSSHHelpers', () => {
  it('detectFramework returns generic in node/jsdom', () => {
    const fw = LunaSSHHelpers.detectFramework();
    expect(['generic','nextjs','vite','webpack']).toContain(fw);
  });

  it('getAssetPaths respects publicDir', () => {
    const p = LunaSSHHelpers.getAssetPaths('/custom/');
    expect(p.wasmPath).toBe('/custom/lunassh.wasm');
    expect(p.wasmExecPath).toBe('/custom/wasm_exec.js');
  });

  it('getAssetPaths default publicDir', () => {
    const p = LunaSSHHelpers.getAssetPaths();
    expect(p.wasmPath).toBe('/lunassh.wasm');
  });
});

describe('SSHClient initialize errors (no real WASM)', () => {
  it('forwards the SSH authentication banner callback through the WASM connect bridge', async () => {
    const transport = new WispTransport('auth-banner', {
      wispUrl: 'wss://wisp.example/', sshHost: 'ssh.example', sshPort: 22,
    });
    vi.spyOn(transport, 'connect').mockResolvedValue();
    const wasm = {
      createTransport: vi.fn(), injectTransportData: vi.fn(), closeTransport: vi.fn(),
      connect: vi.fn().mockImplementation(async (_options, _id, callbacks) => {
        callbacks.onAuthBanner('Visit https://login.tailscale.com/a/check\r\n');
        throw new Error('SSH authentication rejected');
      }),
    };
    (SSHClient as any).initialized = true;
    (SSHClient as any).wasmInstance = wasm;
    wasmTransportManager.setWasm(wasm);
    const onAuthBanner = vi.fn();

    await expect(SSHClient.connect(
      { host: 'ssh.example', port: 22, user: 'alice' }, transport, { onAuthBanner },
    )).rejects.toThrow('SSH authentication rejected');
    expect(onAuthBanner).toHaveBeenCalledExactlyOnceWith('Visit https://login.tailscale.com/a/check\r\n');
  });

  it('starts the interactive SSH session before resize is exposed to callers', async () => {
    const transport = new WispTransport('interactive-connect', {
      wispUrl: 'wss://wisp.example/', sshHost: 'ssh.example', sshPort: 22,
    });
    vi.spyOn(transport, 'connect').mockResolvedValue();
    const resizeTerminal = vi.fn().mockResolvedValue(undefined);
    const wasm = {
      createTransport: vi.fn(),
      injectTransportData: vi.fn(),
      closeTransport: vi.fn(),
      connect: vi.fn().mockResolvedValue({
        sessionId: 'interactive-session',
        send: vi.fn(),
        disconnect: vi.fn(),
        resizeTerminal,
      }),
    };
    (SSHClient as any).initialized = true;
    (SSHClient as any).wasmInstance = wasm;
    wasmTransportManager.setWasm(wasm);

    const session = await SSHClient.connect({ host: 'ssh.example', port: 22, user: 'alice' }, transport);
    await expect(session.resizeTerminal(120, 40)).resolves.toBeUndefined();

    expect(resizeTerminal).toHaveBeenCalledWith(120, 40);
  });

  it('shares one in-flight asset initialization between concurrent callers', async () => {
    const append = vi.fn((node: any) => {
      (window as any).Go = class { importObject = {}; run = () => { (window as any).SSHClient = { connect: vi.fn() }; }; };
      queueMicrotask(() => node.onload?.());
      return node;
    });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { createElement: () => ({}), head: { appendChild: append } });
    const fetch = vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('WebAssembly', { instantiate: vi.fn().mockResolvedValue({ instance: {} }) });

    await Promise.all([
      SSHClient.initialize({ wasmPath: '/lunassh.wasm', wasmExecPath: '/wasm_exec.js' }),
      SSHClient.initialize({ wasmPath: '/lunassh.wasm', wasmExecPath: '/wasm_exec.js' }),
    ]);

    expect(append).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('waits for delayed WASM readiness instead of assuming a fixed delay', async () => {
    const append = vi.fn((node: any) => {
      (window as any).Go = class { importObject = {}; run = () => { setTimeout(() => { (window as any).SSHClient = { connect: vi.fn() }; }, 150); }; };
      queueMicrotask(() => node.onload?.());
      return node;
    });
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('document', { createElement: () => ({}), head: { appendChild: append } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal('WebAssembly', { instantiate: vi.fn().mockResolvedValue({ instance: {} }) });

    await expect(SSHClient.initialize({ wasmPath: '/lunassh.wasm', wasmExecPath: '/wasm_exec.js', timeout: 500 })).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledOnce();
  });

  it('uses Vite development mode when initializing through the helper', async () => {
    const initialize = vi.spyOn(SSHClient, 'initialize').mockResolvedValue();
    await LunaSSHHelpers.initializeForVite();
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ cacheBusting: true }));
  });

  it('closes a supported transport when WASM connection fails', async () => {
    const transport = new WispTransport('failed-connect', {
      wispUrl: 'wss://wisp.example/', sshHost: 'ssh.example', sshPort: 22,
    });
    const disconnect = vi.spyOn(transport, 'disconnect').mockResolvedValue();
    const wasm = {
      createTransport: vi.fn(),
      injectTransportData: vi.fn(),
      closeTransport: vi.fn(),
      connect: vi.fn().mockRejectedValue(new Error('WASM connect failed')),
    };
    vi.spyOn(transport, 'connect').mockResolvedValue();
    (SSHClient as any).initialized = true;
    (SSHClient as any).wasmInstance = wasm;
    wasmTransportManager.setWasm(wasm);

    await expect(SSHClient.connect({ host: 'ssh.example', port: 22, user: 'alice' }, transport)).rejects.toThrow('WASM connect failed');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(wasm.closeTransport).toHaveBeenCalledWith('failed-connect');
  });

  it('rejects legacy string initialization paths', async () => {
    await expect(SSHClient.initialize('/legacy.wasm' as never)).rejects.toThrow(
      'Initialization options must be an object',
    );
  });

  it('throws if not initialized and connect called', async () => {
    expect(() => SSHClient.getVersion()).toThrow(/not initialized/);
  });
});

describe('provider SSH cancellation', () => {
  const options = { host: 'ssh.example', port: 22, user: 'alice' };

  function setup(dialTcp: () => Promise<any>, connect = vi.fn()) {
    const provider = { dialTcp: vi.fn(dialTcp) };
    const transport = new ProviderTransport('cancel-provider', provider, { sshHost: options.host, sshPort: options.port });
    const wasm = {
      createTransport: vi.fn(), injectTransportData: vi.fn(), closeTransport: vi.fn(), connect,
    };
    (SSHClient as any).initialized = true;
    (SSHClient as any).wasmInstance = wasm;
    wasmTransportManager.setWasm(wasm);
    return { provider, transport, wasm };
  }

  function socket() {
    return { send: vi.fn(), close: vi.fn(), on: vi.fn(() => vi.fn()) };
  }

  it('rejects a pre-aborted attempt without registering or dialing', async () => {
    const { provider, transport, wasm } = setup(async () => socket());
    const controller = new AbortController();
    controller.abort();

    await expect(SSHClient.connect(options, transport, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.dialTcp).not.toHaveBeenCalled();
    expect(wasm.createTransport).not.toHaveBeenCalled();
  });

  it('rejects while dialTcp is still pending and closes a late socket', async () => {
    let resolveDial!: (value: ReturnType<typeof socket>) => void;
    const dial = new Promise<ReturnType<typeof socket>>((resolve) => { resolveDial = resolve; });
    const { provider, transport, wasm } = setup(() => dial);
    const controller = new AbortController();
    const attempt = SSHClient.connect(options, transport, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(provider.dialTcp).toHaveBeenCalledOnce());

    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(wasm.closeTransport).toHaveBeenCalledWith(transport.id);
    expect(wasm.connect).not.toHaveBeenCalled();
    const lateSocket = socket();
    resolveDial(lateSocket);
    await vi.waitFor(() => expect(lateSocket.close).toHaveBeenCalledOnce());
  });

  it('does not begin the Go handshake when abort races dial completion', async () => {
    const controller = new AbortController();
    const connectedSocket = socket();
    let resolveDial!: (value: ReturnType<typeof socket>) => void;
    const dial = new Promise<ReturnType<typeof socket>>((resolve) => { resolveDial = resolve; });
    dial.then(() => queueMicrotask(() => controller.abort()));
    const { provider, transport, wasm } = setup(() => dial);
    const attempt = SSHClient.connect(options, transport, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(provider.dialTcp).toHaveBeenCalledOnce());

    resolveDial(connectedSocket);
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(wasm.connect).not.toHaveBeenCalled();
    expect(connectedSocket.close).toHaveBeenCalledOnce();
  });

  it('closes the registered bridge and socket during a pending Go handshake', async () => {
    const connectedSocket = socket();
    const connect = vi.fn(() => new Promise<unknown>(() => {}));
    const { transport, wasm } = setup(async () => connectedSocket, connect);
    const controller = new AbortController();
    const attempt = SSHClient.connect(options, transport, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    expect(wasm.closeTransport).toHaveBeenCalledWith(transport.id);
    expect(connectedSocket.close).toHaveBeenCalledOnce();
  });

  it('disconnects a session that resolves after the attempt was aborted', async () => {
    const connectedSocket = socket();
    let resolveConnect!: (value: unknown) => void;
    const connect = vi.fn(() => new Promise<unknown>((resolve) => { resolveConnect = resolve; }));
    const { transport, wasm } = setup(async () => connectedSocket, connect);
    const controller = new AbortController();
    const attempt = SSHClient.connect(options, transport, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    controller.abort();
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    const disconnect = vi.fn().mockResolvedValue(undefined);
    resolveConnect({ sessionId: 'late-session', disconnect });
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(wasm.closeTransport).toHaveBeenCalledTimes(1);
    expect(connectedSocket.close).toHaveBeenCalledOnce();
  });

  it('disconnects a session when abort races the resolved handshake continuation', async () => {
    const controller = new AbortController();
    const connectedSocket = socket();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    let resolveConnect!: (value: unknown) => void;
    const connect = vi.fn(() => {
      const promise = new Promise<unknown>((resolve) => { resolveConnect = resolve; });
      promise.then(() => queueMicrotask(() => controller.abort()));
      return promise;
    });
    const { transport } = setup(async () => connectedSocket, connect);
    const attempt = SSHClient.connect(options, transport, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());

    resolveConnect({ sessionId: 'racing-session', disconnect });
    await expect(attempt).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(connectedSocket.close).toHaveBeenCalledOnce();
  });
});
