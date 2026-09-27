import type { WasmTransport } from './bridge';

export interface TcpProviderSocket {
  send(data: Uint8Array): void;
  close(): void;
  on(event: 'data' | 'close' | 'error', listener: (...args: any[]) => void): () => void;
}
export interface TcpProvider {
  dialTcp(host: string, port: number): Promise<TcpProviderSocket>;
}
export interface ProviderTransportOptions { sshHost: string; sshPort: number; }

/** WASM transport backed by any outbound TCP provider. */
export class ProviderTransport implements WasmTransport {
  onData?: (data: Uint8Array) => void;
  onError?: (error: Error) => void;
  onClose?: (error?: Error) => void;
  private socket: TcpProviderSocket | null = null;
  private socketUnsubscribes: Array<() => void> = [];
  private connectionAttempt = 0;
  private closed = false;
  constructor(public readonly id: string, private readonly provider: TcpProvider, private readonly opts: ProviderTransportOptions) {}
  async connect(): Promise<void> {
    if (this.socket) throw new Error('ProviderTransport: already connected');
    this.closed = false;
    const connectionAttempt = ++this.connectionAttempt;
    const socket = await this.provider.dialTcp(this.opts.sshHost, this.opts.sshPort);
    if (this.closed || connectionAttempt !== this.connectionAttempt || this.socket) { socket.close(); return; }
    this.socket = socket;
    try {
      this.socketUnsubscribes.push(socket.on('data', (data: Uint8Array) => {
        if (this.socket === socket && !this.closed) this.onData?.(new Uint8Array(data));
      }));
      this.socketUnsubscribes.push(socket.on('error', (error: Error) => {
        if (this.socket === socket && !this.closed) this.onError?.(error instanceof Error ? error : new Error(String(error)));
      }));
      this.socketUnsubscribes.push(socket.on('close', () => this.handleClose(socket)));
    } catch (error) {
      this.closed = true;
      this.socket = null;
      try { this.unsubscribeSocket(); } finally { socket.close(); }
      throw error;
    }
  }
  async send(data: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('ProviderTransport: closed');
    if (!this.socket) throw new Error('ProviderTransport: not connected - call connect() first');
    this.socket.send(data);
  }
  async disconnect(): Promise<void> {
    if (this.closed && !this.socket) return;
    this.closed = true;
    ++this.connectionAttempt;
    const socket = this.socket;
    this.socket = null;
    try { this.unsubscribeSocket(); } finally {
      try { socket?.close(); } finally { this.onClose?.(); }
    }
  }
  get isConnected(): boolean { return !!this.socket && !this.closed; }
  private handleClose(socket: TcpProviderSocket): void {
    if (this.closed || this.socket !== socket) return;
    this.closed = true;
    this.socket = null;
    try { this.unsubscribeSocket(); } finally { this.onClose?.(); }
  }
  private unsubscribeSocket(): void {
    const unsubscribes = this.socketUnsubscribes;
    this.socketUnsubscribes = [];
    let failure: unknown;
    for (const unsubscribe of unsubscribes) {
      try { unsubscribe(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
}
