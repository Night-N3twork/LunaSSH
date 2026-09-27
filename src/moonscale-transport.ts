import { ProviderTransport } from './provider-transport';
import type { ProviderTransportOptions, TcpProvider, TcpProviderSocket } from './provider-transport';

export type MoonScaleTcpSocket = TcpProviderSocket;

export type MoonScaleClient = TcpProvider;

export type MoonScaleTransportOptions = ProviderTransportOptions;

/** @deprecated Use ProviderTransport with a generic TcpProvider. */
export class MoonScaleTransport extends ProviderTransport {
  constructor(id: string, client: MoonScaleClient, opts: MoonScaleTransportOptions) { super(id, client, opts); }
}
