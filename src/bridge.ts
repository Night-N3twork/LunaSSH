export interface WasmTransport {
  readonly id: string;
  onData?: (data: Uint8Array) => void;
  onError?: (error: Error) => void;
  onClose?: (error?: Error) => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(data: Uint8Array): Promise<void>;
}

interface WasmBridge {
  createTransport(id: string, callbacks: { onWrite(data: Uint8Array): void; onClose(): void }): void;
  injectTransportData(id: string, data: Uint8Array): void;
  closeTransport(id: string): void;
  failTransport(id: string, reason: number): void;
}

export class WasmTransportManager {
  private readonly transports = new Map<string, WasmTransport>();
  private wasm: WasmBridge | undefined;

  setWasm(wasm: WasmBridge): void {
    this.wasm = wasm;
  }

  async register(transport: WasmTransport): Promise<void> {
    if (!this.wasm) throw new Error('WASM instance not set');

    this.wasm.createTransport(transport.id, {
      onWrite: (data) => {
        void transport.send(data).catch((error: unknown) => {
          transport.onError?.(error instanceof Error ? error : new Error(String(error)));
        });
      },
      onClose: () => {
        void this.close(transport.id);
      },
    });

    transport.onData = (data) => this.wasm?.injectTransportData(transport.id, data);
    const peerOnClose = transport.onClose;
    transport.onClose = (error) => {
      if (error instanceof WispTransportCloseError) {
        this.transports.delete(transport.id);
        this.wasm?.failTransport(transport.id, error.reason);
      } else {
        void this.close(transport.id, false);
      }
      peerOnClose?.();
    };
    this.transports.set(transport.id, transport);
  }

  async close(id: string, disconnect = true): Promise<void> {
    const transport = this.transports.get(id);
    if (!transport) return;

    this.transports.delete(id);
    this.wasm?.closeTransport(id);
    if (disconnect) await transport.disconnect();
  }
}

/** A Wisp CLOSE frame's reason code, intentionally excluding its payload. */
export class WispTransportCloseError extends Error {
  constructor(readonly reason: number) {
    super(`Wisp transport closed: ${wispCloseReasonName(reason)} (0x${reason.toString(16).padStart(2, '0')})`);
    this.name = 'WispTransportCloseError';
  }
}

function wispCloseReasonName(reason: number): string {
  switch (reason) {
    case 0x01: return 'UNKNOWN';
    case 0x02: return 'VOLUNTARY';
    case 0x03: return 'NETWORK_ERROR';
    case 0x04: return 'INCOMPATIBLE_EXTENSIONS';
    case 0x41: return 'STREAM_INVALID_INFO';
    case 0x42: return 'STREAM_UNREACHABLE';
    case 0x43: return 'STREAM_TIMED_OUT';
    case 0x44: return 'STREAM_REFUSED';
    case 0x47: return 'TCP_DATA_TIMED_OUT';
    case 0x48: return 'STREAM_BLOCKED';
    case 0x49: return 'THROTTLED';
    case 0x81: return 'CLIENT_ERROR';
    case 0xc0: return 'AUTH_INVALID_PASSWORD';
    case 0xc1: return 'AUTH_INVALID_SIGNATURE';
    case 0xc2: return 'AUTH_REQUIRED';
    default: return 'UNRECOGNIZED';
  }
}

export const wasmTransportManager = new WasmTransportManager();
