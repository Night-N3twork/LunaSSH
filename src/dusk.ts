import { SSHClient, type InitializationOptions, type SSHSession } from './client';
import { SSHWispClient } from './ssh-wisp-client';
import type { WasmTransport } from './bridge';
import type { TcpProvider } from './provider-transport';

export interface StreamingHostBinaryContext {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: ReadableStream<Uint8Array>;
  stdout(data: Uint8Array): Promise<void>;
  stderr(data: Uint8Array): Promise<void>;
}

export interface StreamingHostProcess {
  exit: Promise<number>;
  kill(): void;
}

declare const require: (specifier: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  stdin: AsyncIterable<Uint8Array>;
  stdout: { write(data: string | Uint8Array): void };
  stderr: { write(data: string | Uint8Array): void };
};

interface GuestSocket {
  once(event: 'connect' | 'error', callback: (error?: Error) => void): void;
  on(event: 'data' | 'error' | 'close', callback: (value?: Uint8Array | Error) => void): void;
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
}

class DuskSocketTransport implements WasmTransport {
  readonly id: string;
  onData?: (data: Uint8Array) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  private socket: GuestSocket | undefined;

  constructor(id: string, private readonly host: string, private readonly port: number) { this.id = id; }

  async connect(): Promise<void> {
    const net = require('node:net') as { connect(options: { host: string; port: number }): GuestSocket };
    this.socket = net.connect({ host: this.host, port: this.port });
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', () => resolve());
      this.socket!.once('error', (error) => reject(error ?? new Error('SSH socket connection failed')));
    });
    this.socket.on('data', (data) => this.onData?.(new Uint8Array(data as Uint8Array)));
    this.socket.on('error', (error) => this.onError?.(error as Error));
    this.socket.on('close', () => this.onClose?.());
  }

  async send(data: Uint8Array): Promise<void> {
    if (!this.socket) throw new Error('DuskSocketTransport: not connected');
    this.socket.write(data);
  }

  async disconnect(): Promise<void> {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = undefined;
  }
}

export type StreamingHostBinary = (context: StreamingHostBinaryContext) => Promise<StreamingHostProcess>;

export interface SSHCommandOptions {
  /** Direct Wisp endpoint. Required unless a MoonBeam relay is supplied. */
  wispUrl?: string;
  moonbeamRelay?: { attach(): unknown };
  /** Outbound TCP provider supplied by the Dusk host. */
  transportProvider?: TcpProvider;
  readFile?: (path: string, cwd: string) => Promise<string>;
  /** OpenSSH known-host lines with un-hashed host names. */
  knownHosts?: string[];
  /** SHA-256 or MD5 SSH public-key fingerprint. */
  hostKeyFingerprint?: string;
  /** OpenSSH authorized-key public-key representation. */
  hostKey?: string;
  /** Explicitly disable host-key verification. This is insecure. */
  insecureSkipHostKeyVerification?: boolean;
  /** Reject an unknown host after displaying its fingerprint; never persists trust. */
  trustOnFirstUse?: boolean;
  /** Obtained when each ssh command starts so a host UI can update policy after boot. */
  getHostKeyPolicy?: () => HostKeyPolicy;
  /** Explicit browser asset URLs, required when Dusk starts before a UI client. */
  initializationOptions?: InitializationOptions;
}

export interface HostKeyPolicy {
  knownHosts?: string[];
  hostKeyFingerprint?: string;
  hostKey?: string;
  trustOnFirstUse?: boolean;
}

export type DuskHostKeyVerification =
  | { knownHosts: readonly string[] }
  | { hostKeyFingerprint: string }
  | { hostKey: string }
  | { insecureSkipHostKeyVerification: true }
  | { trustOnFirstUse: true };

export interface DuskSshAdapterContext {
  relay: { attach(): unknown };
  transportProvider?: TcpProvider;
  readFile(path: string, cwd: string): Promise<string>;
  hostKeyVerification: DuskHostKeyVerification;
  wasm: Required<Pick<InitializationOptions, 'wasmPath' | 'wasmExecPath'>>;
  registerSsh(binary: StreamingHostBinary): void;
}

export interface DuskSshAdapter {
  register(context: DuskSshAdapterContext): void;
}

export interface StreamingHostBinaryRegistrar {
  registerStreamingHostBinary(name: string, binary: StreamingHostBinary): void;
}

/** Creates the host-supplied adapter required by Dusk's public SSH boundary. */
export function createDuskSshAdapter(): DuskSshAdapter {
  return {
    register(context) {
      const policy = context.hostKeyVerification;
      const invalidPolicy = 'invalid Dusk host-key verification policy: provide exactly one of nonempty knownHosts, hostKeyFingerprint, hostKey, trustOnFirstUse: true, or insecureSkipHostKeyVerification: true';
      if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).length !== 1) {
        throw new Error(invalidPolicy);
      }
      let verification: SSHCommandOptions;
      if ('knownHosts' in policy && Array.isArray(policy.knownHosts) && policy.knownHosts.length > 0
        && policy.knownHosts.every((line) => typeof line === 'string' && line.trim().split(/\s+/).length >= 3)) {
        verification = { knownHosts: [...policy.knownHosts] };
      } else if ('hostKeyFingerprint' in policy && typeof policy.hostKeyFingerprint === 'string'
        && /^(SHA256|MD5):\S+$/.test(policy.hostKeyFingerprint)) {
        verification = { hostKeyFingerprint: policy.hostKeyFingerprint };
      } else if ('hostKey' in policy && typeof policy.hostKey === 'string' && /^\S+\s+\S+/.test(policy.hostKey)) {
        verification = { hostKey: policy.hostKey };
      } else if ('trustOnFirstUse' in policy && policy.trustOnFirstUse === true) {
        verification = { trustOnFirstUse: true };
      } else if ('insecureSkipHostKeyVerification' in policy && policy.insecureSkipHostKeyVerification === true) {
        verification = { insecureSkipHostKeyVerification: true };
      } else {
        throw new Error(invalidPolicy);
      }
      registerSSHCommand({
        registerStreamingHostBinary(name, binary) {
          if (name !== 'ssh') throw new Error(`Dusk SSH adapter cannot register ${name}`);
          context.registerSsh(binary);
        },
      }, {
        moonbeamRelay: context.relay,
        transportProvider: context.transportProvider,
        readFile: context.readFile,
        initializationOptions: context.wasm,
        ...verification,
      });
    },
  };
}

interface SSHArguments {
  host: string;
  port: number;
  user: string;
  privateKeyPath?: string;
  hostKeyFingerprint?: string;
}

const usage = 'usage: ssh [-p PORT] [-l USER] [-i KEY_PATH] [-o HostKeyFingerprint=SHA256:...] host\n';

export function parseSSHArguments(args: string[]): SSHArguments | undefined {
  let port = 22;
  let user = '';
  let privateKeyPath: string | undefined;
  let hostKeyFingerprint: string | undefined;
  let host: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '-p' || argument === '-l' || argument === '-i' || argument === '-o') {
      const value = args[++index];
      if (!value) return undefined;
      if (argument === '-p') {
        port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
      } else if (argument === '-l') user = value;
      else if (argument === '-i') privateKeyPath = value;
      else {
        const match = /^HostKeyFingerprint=(SHA256|MD5):.+$/.exec(value);
        if (!match) return undefined;
        hostKeyFingerprint = value.slice('HostKeyFingerprint='.length);
      }
    } else if (!argument.startsWith('-') && !host) host = argument;
    else return undefined;
  }

  return host ? { host, port, user, privateKeyPath, hostKeyFingerprint } : undefined;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function resolveHostKeyPolicy(options: SSHCommandOptions): HostKeyPolicy {
  const policy = options.getHostKeyPolicy?.() ?? {
    knownHosts: options.knownHosts,
    hostKeyFingerprint: options.hostKeyFingerprint,
    hostKey: options.hostKey,
    trustOnFirstUse: options.trustOnFirstUse,
  };
  if (!policy.knownHosts?.length && !policy.hostKeyFingerprint && !policy.hostKey && !policy.trustOnFirstUse && !options.insecureSkipHostKeyVerification) {
    throw new Error('host key verification requires knownHosts, hostKeyFingerprint, hostKey, trustOnFirstUse, or insecureSkipHostKeyVerification');
  }
  if (policy.hostKeyFingerprint && !/^(SHA256|MD5):/.test(policy.hostKeyFingerprint)) {
    throw new Error('invalid host-key policy: fingerprint must begin SHA256: or MD5:');
  }
  if (policy.knownHosts?.some((line) => line.trim().split(/\s+/).length < 3)) {
    throw new Error('invalid host-key policy: known-host entries require host, key type, and key data');
  }
  return policy;
}

export function registerSSHCommand(processManager: StreamingHostBinaryRegistrar, options: SSHCommandOptions): void {
  if (!options.wispUrl && !options.moonbeamRelay && !options.transportProvider) {
    throw new Error('registerSSHCommand requires options.wispUrl, options.moonbeamRelay, or options.transportProvider');
  }

  const binary: StreamingHostBinary = async (context: StreamingHostBinaryContext): Promise<StreamingHostProcess> => {
    const parsed = parseSSHArguments(context.args);
    if (!parsed) {
      await context.stderr(encode(usage));
      return { exit: Promise.resolve(2), kill: () => {} };
    }

    let session: SSHSession | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let killed = false;
    const abort = new AbortController();
    const cancelled = new Promise<undefined>((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(undefined), { once: true });
    });
    const exit = (async (): Promise<number> => {
      try {
        let privateKey: string | undefined;
        if (parsed.privateKeyPath) {
          if (!options.readFile) throw new Error('ssh: -i requires registerSSHCommand option readFile');
          privateKey = await Promise.race([options.readFile(parsed.privateKeyPath, context.cwd), cancelled]);
        }
        if (killed) return 0;

        const hostKeyPolicy = parsed.hostKeyFingerprint
          ? { hostKeyFingerprint: parsed.hostKeyFingerprint }
          : resolveHostKeyPolicy(options);

        await Promise.race([SSHClient.initialize(options.initializationOptions ?? {}), cancelled]);
        if (killed) return 0;
        const callbacks = { onTerminalOutput: (chunk: Uint8Array) => killed ? undefined : context.stdout(chunk) };
        const connection = {
          host: parsed.host,
          port: parsed.port,
          user: parsed.user || context.env.USER || '',
          password: context.env.DUSK_SSH_PASSWORD,
          privateKey,
          knownHosts: hostKeyPolicy.knownHosts,
          hostKeyFingerprint: hostKeyPolicy.hostKeyFingerprint,
          hostKey: hostKeyPolicy.hostKey,
          trustOnFirstUse: hostKeyPolicy.trustOnFirstUse,
          insecureSkipHostKeyVerification: parsed.hostKeyFingerprint ? false : options.insecureSkipHostKeyVerification,
        };
        const connectOptions = { signal: abort.signal };
        session = options.transportProvider
          ? await SSHWispClient.connectViaProvider(connection, options.transportProvider, callbacks, connectOptions)
          : options.moonbeamRelay
            ? await SSHWispClient.connectViaMoonbeam(connection, options.moonbeamRelay, callbacks, connectOptions)
            : await SSHWispClient.connectViaWisp({ ...connection, wispUrl: options.wispUrl! }, callbacks, connectOptions);
        if (killed) return 0;
        const input = context.stdin.getReader();
        reader = input;
        while (!killed) {
          const { done, value } = await input.read();
          if (done) break;
          await session.send(value);
        }
        return 0;
      } catch (error) {
        if (killed) return 0;
        await context.stderr(encode(`ssh: ${error instanceof Error ? error.message : String(error)}\n`));
        return 1;
      } finally {
        await reader?.cancel().catch(() => {});
        await session?.disconnect().catch(() => {});
      }
    })();

    return {
      exit,
      kill: () => {
        killed = true;
        abort.abort();
        void reader?.cancel().catch(() => {});
        void session?.disconnect().catch(() => {});
      },
    };
  };

  processManager.registerStreamingHostBinary('ssh', binary);
}

/** Runs the installed ssh package in a Dusk guest through node:net. */
export async function runDuskSsh(args: string[]): Promise<number> {
  const parsed = parseSSHArguments(args);
  if (!parsed) {
    process.stderr.write(usage);
    return 2;
  }
  if (!parsed.hostKeyFingerprint) {
    process.stderr.write('ssh: host key verification requires -o HostKeyFingerprint=SHA256:...\n');
    return 1;
  }

  let session: SSHSession | undefined;
  try {
    await SSHClient.initialize({
      wasmPath: process.env.DUSK_LUNASSH_WASM,
      wasmExecPath: process.env.DUSK_LUNASSH_WASM_EXEC,
    });
    const transport = new DuskSocketTransport(`dusk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, parsed.host, parsed.port);
    session = await SSHClient.connect({
      host: parsed.host,
      port: parsed.port,
      user: parsed.user || process.env.USER || '',
      password: process.env.DUSK_SSH_PASSWORD,
      hostKeyFingerprint: parsed.hostKeyFingerprint,
    }, transport as never, { onTerminalOutput: (chunk) => process.stdout.write(chunk) });
    for await (const chunk of process.stdin) await session.send(chunk as Uint8Array);
    return 0;
  } catch (error) {
    process.stderr.write(`ssh: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await session?.disconnect().catch(() => {});
  }
}
