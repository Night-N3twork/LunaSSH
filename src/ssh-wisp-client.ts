/**
 * SSHWispClient — ergonomic helpers for SSH over Wisp / Moonbeam
 *
 * Thin wrapper around SSHClient + new transports so callers don't
 * manually wire the internal WASM bridge. Keeps the existing SSHClient API
 * intact for power users, adds `connectViaWisp` / `connectViaMoonbeam`
 * shortcuts.
 */

import { SSHClient, type ConnectionOptions, type SSHClientCallbacks, type SSHSession } from './client';
import { WispTransport, type WispTransportOptions } from './wisp-transport';
import { MoonbeamTransport } from './moonbeam-transport';
import { MoonScaleTransport, type MoonScaleClient, type MoonScaleTransportOptions } from './moonscale-transport';
import { ProviderTransport, type TcpProvider } from './provider-transport';

export interface WispSSHOptions extends ConnectionOptions {
  /** wss:// URL of the Wisp server */
  wispUrl: string;
  /** Optional WispClient tuning forwarded to WispTransport */
  wispConfig?: WispTransportOptions['wispConfig'];
}

export class SSHWispClient {
  /**
   * Connect to an SSH server via a direct Wisp WebSocket.
   * Example:
   *   await SSHClient.initialize();
   *   const sess = await SSHWispClient.connectViaWisp({
   *     host: '203.0.113.1', port: 22, user: 'root', password: '...',
   *     wispUrl: 'wss://wisp.example.com/'
   *   });
   */
  static async connectViaWisp(
    opts: WispSSHOptions,
    callbacks?: SSHClientCallbacks,
    connectOptions?: { signal?: AbortSignal },
  ): Promise<SSHSession> {
    const { wispUrl, wispConfig, ...sshOpts } = opts;
    if (!wispUrl) throw new Error('SSHWispClient.connectViaWisp: wispUrl is required');

    const transport = new WispTransport(`wisp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, {
      wispUrl,
      sshHost: sshOpts.host,
      sshPort: sshOpts.port,
      connectionTimeoutMs: (sshOpts.timeout ?? 30) * 1000,
      wispConfig,
    });

    return SSHClient.connect(sshOpts, transport, callbacks, connectOptions);
  }

  /**
   * Connect via an already-created MoonbeamRelay.
   * Example:
   *   const relay = await MoonbeamRelay.create({ wispUrl: 'wss://wisp.example.com/' });
   *   const sess = await SSHWispClient.connectViaMoonbeam({host,port,user,...}, relay);
   */
  static async connectViaMoonbeam(
    opts: ConnectionOptions,
    relay: any,
    callbacks?: SSHClientCallbacks,
    connectOptions?: { signal?: AbortSignal },
  ): Promise<SSHSession> {
    if (!relay || typeof relay.attach !== 'function') {
      throw new Error('SSHWispClient.connectViaMoonbeam: relay must be a MoonbeamRelay (with .attach())');
    }

    const transport = new MoonbeamTransport(
      `moonbeam-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      relay,
      { sshHost: opts.host, sshPort: opts.port },
    );

    return SSHClient.connect(opts, transport, callbacks, connectOptions);
  }

  /** Connect directly to a tailnet target through MoonScale TCP. */
  static async connectViaMoonScaleTcp(
    opts: ConnectionOptions,
    client: MoonScaleClient,
    callbacks?: SSHClientCallbacks,
  ): Promise<SSHSession> {
    const transport = new MoonScaleTransport(
      `moonscale-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      client,
      { sshHost: opts.host, sshPort: opts.port },
    );
    return SSHClient.connect(opts, transport, callbacks);
  }

  /** Connect through any outbound TCP provider; pass { signal } to cancel a pending attempt. */
  static async connectViaProvider(
    opts: ConnectionOptions,
    provider: TcpProvider,
    callbacks?: SSHClientCallbacks,
    connectOptions?: { signal?: AbortSignal },
  ): Promise<SSHSession> {
    const transport = new ProviderTransport(
      `provider-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      provider,
      { sshHost: opts.host, sshPort: opts.port },
    );
    return SSHClient.connect(opts, transport, callbacks, connectOptions);
  }

  /**
   * Create a WispTransport instance without connecting — for advanced use
   * where you want to manage its lifecycle yourself.
   */
  static createWispTransport(id: string, opts: WispTransportOptions): WispTransport {
    return new WispTransport(id, opts);
  }

  /**
   * Create a MoonbeamTransport instance without connecting.
   */
  static createMoonbeamTransport(id: string, relay: any, opts: { sshHost: string; sshPort: number }): MoonbeamTransport {
    return new MoonbeamTransport(id, relay, opts);
  }

  static createMoonScaleTransport(id: string, client: MoonScaleClient, opts: MoonScaleTransportOptions): MoonScaleTransport {
    return new MoonScaleTransport(id, client, opts);
  }
}
