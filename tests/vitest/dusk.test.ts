import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDuskSshAdapter, parseSSHArguments, registerSSHCommand } from '../../src/dusk';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}),
  connectViaWisp: vi.fn(),
  connectViaMoonbeam: vi.fn(),
  connectViaProvider: vi.fn(),
}));

vi.mock('../../src/client', () => ({ SSHClient: { initialize: mocks.initialize } }));
vi.mock('../../src/ssh-wisp-client', () => ({
  SSHWispClient: { connectViaWisp: mocks.connectViaWisp, connectViaMoonbeam: mocks.connectViaMoonbeam, connectViaProvider: mocks.connectViaProvider },
}));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function stdin(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe('registerSSHCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectViaWisp.mockResolvedValue({
      send: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
    });
    mocks.connectViaMoonbeam.mockResolvedValue({
      send: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
    });
    mocks.connectViaProvider.mockResolvedValue({
      send: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
    });
  });

  it('registers ssh with Dusk streaming lifecycle, forwards terminal output and closes the session', async () => {
    let binary: any;
    const processManager = {
      registerStreamingHostBinary: vi.fn((_name, registered) => { binary = registered; }),
    };
    registerSSHCommand(processManager, { wispUrl: 'wss://wisp.example/', hostKeyFingerprint: 'SHA256:server-key' });

    expect(processManager.registerStreamingHostBinary).toHaveBeenCalledWith('ssh', expect.any(Function));
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const process = await binary({
      args: ['-p', '2200', '-l', 'alice', 'example.test'],
      cwd: '/',
      env: { DUSK_SSH_PASSWORD: 'secret' },
      stdin: stdin([encoder.encode('ls\n')]),
      stdout: async (chunk: Uint8Array) => { stdout.push(chunk); },
      stderr: async (chunk: Uint8Array) => { stderr.push(chunk); },
    });

    await vi.waitFor(() => expect(mocks.connectViaWisp).toHaveBeenCalledOnce());
    const callbacks = mocks.connectViaWisp.mock.calls[0][1];
    callbacks.onTerminalOutput(encoder.encode('remote$ '));
    await expect(process.exit).resolves.toBe(0);

    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({
      host: 'example.test', port: 2200, user: 'alice', password: 'secret', wispUrl: 'wss://wisp.example/', hostKeyFingerprint: 'SHA256:server-key',
    }), expect.any(Object), expect.any(Object));
    expect(decoder.decode(stdout[0])).toBe('remote$ ');
    expect(stderr).toEqual([]);
    expect(mocks.connectViaWisp.mock.results[0].value).resolves;
  });

  it('parses -i and uses the configured VFS reader', async () => {
    let binary: any;
    const readFile = vi.fn(async () => 'PRIVATE KEY');
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', readFile, hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample',
    });

    const process = await binary({
      args: ['-i', '/keys/id_ed25519', 'host'], cwd: '/home/alice', env: {}, stdin: stdin([]),
      stdout: async () => {}, stderr: async () => {},
    });
    await expect(process.exit).resolves.toBe(0);

    expect(readFile).toHaveBeenCalledWith('/keys/id_ed25519', '/home/alice');
    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({ privateKey: 'PRIVATE KEY' }), expect.any(Object), expect.any(Object));
  });

  it('uses Dusk USER when -l is omitted', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, { wispUrl: 'wss://wisp.example/', knownHosts: ['host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample'] });
    const process = await binary({
      args: ['host'], cwd: '/', env: { USER: 'dusk-user' }, stdin: stdin([]),
      stdout: async () => {}, stderr: async () => {},
    });

    await expect(process.exit).resolves.toBe(0);
    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({ user: 'dusk-user' }), expect.any(Object), expect.any(Object));
  });

  it('uses a Moonbeam relay without requiring a direct Wisp URL', async () => {
    let binary: any;
    const relay = { attach: vi.fn() };
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      moonbeamRelay: relay,
      hostKeyFingerprint: 'SHA256:server-key',
    });

    const process = await binary({
      args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {},
    });

    await expect(process.exit).resolves.toBe(0);
    expect(mocks.connectViaMoonbeam).toHaveBeenCalledWith(expect.objectContaining({ host: 'host' }), relay, expect.any(Object), expect.any(Object));
    expect(mocks.connectViaWisp).not.toHaveBeenCalled();
  });

  it('consumes a generic TCP provider without Dusk knowing MoonScale', async () => {
    let binary: any;
    const transportProvider = { dialTcp: vi.fn() };
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      transportProvider,
      hostKeyFingerprint: 'SHA256:server-key',
    });

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);

    expect(mocks.connectViaProvider).toHaveBeenCalledWith(expect.objectContaining({ host: 'host' }), transportProvider, expect.any(Object), expect.any(Object));
    expect(mocks.connectViaMoonbeam).not.toHaveBeenCalled();
  });

  it('requires a direct Wisp URL, Moonbeam relay, or TCP provider', () => {
    expect(() => registerSSHCommand({ registerStreamingHostBinary: () => {} }, {
      hostKeyFingerprint: 'SHA256:server-key',
    })).toThrow(/options\.wispUrl, options\.moonbeamRelay, or options\.transportProvider/);
  });

  it('reports invalid CLI syntax without opening a session', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, { wispUrl: 'wss://wisp.example/', hostKeyFingerprint: 'SHA256:server-key' });
    const stderr: Uint8Array[] = [];
    const process = await binary({
      args: ['-p', 'not-a-port'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {},
      stderr: async (chunk: Uint8Array) => { stderr.push(chunk); },
    });

    await expect(process.exit).resolves.toBe(2);
    expect(decoder.decode(stderr[0])).toMatch(/usage: ssh/);
    expect(mocks.connectViaWisp).not.toHaveBeenCalled();
  });

  it('rejects unconfigured host-key verification before initializing WASM or connecting', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, { wispUrl: 'wss://wisp.example/' });
    const stderr: Uint8Array[] = [];

    const process = await binary({
      args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {},
      stderr: async (chunk: Uint8Array) => { stderr.push(chunk); },
    });

    await expect(process.exit).resolves.toBe(1);
    expect(decoder.decode(stderr[0])).toMatch(/host key verification requires knownHosts, hostKeyFingerprint, hostKey, trustOnFirstUse, or insecureSkipHostKeyVerification/);
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.connectViaWisp).not.toHaveBeenCalled();
  });

  it('reads a current fingerprint policy when the ssh command starts', async () => {
    let binary: any;
    const getHostKeyPolicy = vi.fn(() => ({ hostKeyFingerprint: 'SHA256:current-server-key' }));
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', getHostKeyPolicy,
    } as any);

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);
    expect(getHostKeyPolicy).toHaveBeenCalledOnce();
    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({ hostKeyFingerprint: 'SHA256:current-server-key' }), expect.any(Object), expect.any(Object));
  });

  it('rejects malformed dynamic host-key policy before initializing', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', getHostKeyPolicy: () => ({ hostKeyFingerprint: 'invalid' }),
    } as any);
    const stderr: Uint8Array[] = [];
    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async (chunk: Uint8Array) => { stderr.push(chunk); } });

    await expect(process.exit).resolves.toBe(1);
    expect(decoder.decode(stderr[0])).toMatch(/invalid host-key policy/i);
    expect(mocks.initialize).not.toHaveBeenCalled();
  });

  it('forwards known-host and insecure verification options', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', knownHosts: ['host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample'], insecureSkipHostKeyVerification: true,
    });

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);
    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({
      knownHosts: ['host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample'], insecureSkipHostKeyVerification: true,
    }), expect.any(Object), expect.any(Object));
  });

  it('forwards trust-on-first-use without enabling insecure verification', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', trustOnFirstUse: true,
    });

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);

    expect(mocks.connectViaWisp).toHaveBeenCalledWith(expect.objectContaining({
      trustOnFirstUse: true, insecureSkipHostKeyVerification: undefined,
    }), expect.any(Object), expect.any(Object));
  });

  it('explicit CLI fingerprint disables an insecure registered default', async () => {
    let binary: any;
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', insecureSkipHostKeyVerification: true,
    });
    const process = await binary({ args: ['-o', 'HostKeyFingerprint=SHA256:pinned', 'host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);
    expect(mocks.connectViaWisp.mock.calls[0][0]).toEqual(expect.objectContaining({
      hostKeyFingerprint: 'SHA256:pinned', insecureSkipHostKeyVerification: false,
    }));
  });

  it.each(['provider', 'wisp', 'moonbeam'] as const)('kills a pending %s connection without writing errors', async (kind) => {
    let binary: any;
    const connect = kind === 'provider' ? mocks.connectViaProvider : kind === 'moonbeam' ? mocks.connectViaMoonbeam : mocks.connectViaWisp;
    connect.mockImplementation((_options, _second, third, fourth) => {
      const signal: AbortSignal = (kind === 'wisp' ? third : fourth).signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    });
    const stderr = vi.fn();
    const stdout = vi.fn();
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      ...(kind === 'provider' ? { transportProvider: { dialTcp: vi.fn() } } : kind === 'moonbeam' ? { moonbeamRelay: { attach: vi.fn() } } : { wispUrl: 'wss://wisp.example/' }),
      hostKeyFingerprint: 'SHA256:pinned',
    });
    const process = await binary({ args: ['host'], cwd: '/', env: { DUSK_SSH_PASSWORD: 'secret' }, stdin: stdin([]), stdout, stderr });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const signal: AbortSignal = connect.mock.calls[0][kind === 'wisp' ? 2 : 3].signal;
    expect(signal.aborted).toBe(false);
    process.kill();
    await expect(process.exit).resolves.toBe(0);
    expect(signal.aborted).toBe(true);
    connect.mock.calls[0][kind === 'wisp' ? 1 : 2].onTerminalOutput(encoder.encode('late output'));
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('settles on kill during private-key read without starting a connection', async () => {
    let binary: any;
    let finishRead!: (key: string) => void;
    const readFile = vi.fn(() => new Promise<string>((resolve) => { finishRead = resolve; }));
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', hostKeyFingerprint: 'SHA256:pinned', readFile,
    });
    const stderr = vi.fn();
    const process = await binary({ args: ['-i', '/key', 'host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr });
    expect(readFile).toHaveBeenCalledOnce();
    process.kill();
    await expect(process.exit).resolves.toBe(0);
    finishRead('SECRET KEY');
    await Promise.resolve();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.connectViaWisp).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('settles on kill during WASM initialization without connecting or printing errors', async () => {
    let binary: any;
    let finishInitialization!: () => void;
    mocks.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInitialization = resolve; }));
    registerSSHCommand({ registerStreamingHostBinary: (_name, registered) => { binary = registered; } }, {
      wispUrl: 'wss://wisp.example/', hostKeyFingerprint: 'SHA256:pinned',
    });
    const stderr = vi.fn();
    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr });
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());
    process.kill();
    await expect(process.exit).resolves.toBe(0);
    finishInitialization();
    await Promise.resolve();
    expect(mocks.connectViaWisp).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

it('parses an explicit HostKeyFingerprint CLI policy', () => {
  expect(parseSSHArguments(['-o', 'HostKeyFingerprint=SHA256:server-key', 'host'])).toEqual({
    host: 'host', port: 22, user: '', hostKeyFingerprint: 'SHA256:server-key',
  });
});

describe('createDuskSshAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectViaMoonbeam.mockResolvedValue({
      send: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
      resizeTerminal: vi.fn(async () => {}),
    });
  });

  it.each([
    ['empty object', {}],
    ['missing policy', undefined],
    ['wrong insecure literal', { insecureSkipHostKeyVerification: false }],
    ['wrong TOFU literal', { trustOnFirstUse: false }],
    ['wrong knownHosts type', { knownHosts: 'host ssh-ed25519 key' }],
    ['empty knownHosts', { knownHosts: [] }],
    ['invalid knownHosts entry', { knownHosts: [42] }],
    ['wrong fingerprint type', { hostKeyFingerprint: 123 }],
    ['invalid fingerprint', { hostKeyFingerprint: 'invalid' }],
    ['wrong hostKey type', { hostKey: {} }],
    ['empty hostKey', { hostKey: '' }],
    ['ambiguous policy', { hostKeyFingerprint: 'SHA256:key', insecureSkipHostKeyVerification: true }],
  ])('rejects %s instead of enabling insecure verification', (_label, hostKeyVerification) => {
    const registerSsh = vi.fn();
    expect(() => createDuskSshAdapter().register({
      relay: { attach: vi.fn() },
      readFile: vi.fn(async () => ''),
      hostKeyVerification: hostKeyVerification as any,
      wasm: { wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' },
      registerSsh,
    })).toThrow(/invalid Dusk host-key verification policy/i);
    expect(registerSsh).not.toHaveBeenCalled();
  });

  it.each([
    [{ knownHosts: ['host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample'] }, 'knownHosts'],
    [{ hostKeyFingerprint: 'SHA256:server-key' }, 'hostKeyFingerprint'],
    [{ hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample' }, 'hostKey'],
    [{ trustOnFirstUse: true }, 'trustOnFirstUse'],
    [{ insecureSkipHostKeyVerification: true }, 'insecureSkipHostKeyVerification'],
  ] as const)('forwards explicit %s policy without changing verification mode', async (hostKeyVerification, key) => {
    let binary: any;
    createDuskSshAdapter().register({
      relay: { attach: vi.fn() },
      readFile: vi.fn(async () => ''),
      hostKeyVerification,
      wasm: { wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' },
      registerSsh: (registered) => { binary = registered; },
    });
    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);
    expect(mocks.connectViaMoonbeam.mock.calls[0][0][key]).toEqual(hostKeyVerification[key]);
    expect(mocks.connectViaMoonbeam.mock.calls[0][0].insecureSkipHostKeyVerification).toBe(key === 'insecureSkipHostKeyVerification' ? true : undefined);
  });

  it('adapts Dusk configuration into an ssh-only LunaSSH registration', async () => {
    let binary: any;
    const relay = { attach: vi.fn() };
    createDuskSshAdapter().register({
      relay,
      readFile: vi.fn(async () => ''),
      hostKeyVerification: { hostKeyFingerprint: 'SHA256:server-key' },
      wasm: { wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' },
      registerSsh: (registered) => { binary = registered; },
    });

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);

    expect(mocks.initialize).toHaveBeenCalledWith({ wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' });
    expect(mocks.connectViaMoonbeam).toHaveBeenCalledWith(expect.objectContaining({ hostKeyFingerprint: 'SHA256:server-key' }), relay, expect.any(Object), expect.any(Object));
  });

  it('adapts Dusk trust-on-first-use without falling back to insecure verification', async () => {
    let binary: any;
    const relay = { attach: vi.fn() };
    createDuskSshAdapter().register({
      relay,
      readFile: vi.fn(async () => ''),
      hostKeyVerification: { trustOnFirstUse: true },
      wasm: { wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' },
      registerSsh: (registered) => { binary = registered; },
    });

    const process = await binary({ args: ['host'], cwd: '/', env: {}, stdin: stdin([]), stdout: async () => {}, stderr: async () => {} });
    await expect(process.exit).resolves.toBe(0);

    expect(mocks.connectViaMoonbeam).toHaveBeenCalledWith(expect.objectContaining({
      trustOnFirstUse: true, insecureSkipHostKeyVerification: undefined,
    }), relay, expect.any(Object), expect.any(Object));
  });
});
