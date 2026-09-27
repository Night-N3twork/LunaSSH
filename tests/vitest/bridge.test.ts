import { describe, expect, it, vi } from 'vitest';
import { WasmTransportManager, WispTransportCloseError } from '../../src/bridge';
import { WispTransport } from '../../src/wisp-transport';

describe('WasmTransportManager', () => {
  it('closes and removes a supported transport after peer close without recursion', async () => {
    const manager = new WasmTransportManager();
    const wasm = {
      createTransport: vi.fn(),
      injectTransportData: vi.fn(),
      closeTransport: vi.fn(),
    };
    const transport = new WispTransport('peer-closed', {
      wispUrl: 'wss://wisp.example/', sshHost: 'ssh.example', sshPort: 22,
    });
    const peerClose = vi.fn();
    transport.onClose = peerClose;
    manager.setWasm(wasm);

    await manager.register(transport);
    transport.onClose?.();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(wasm.closeTransport).toHaveBeenCalledOnce();
    expect(wasm.closeTransport).toHaveBeenCalledWith('peer-closed');
    expect((manager as any).transports.has('peer-closed')).toBe(false);
    expect(peerClose).toHaveBeenCalledOnce();
  });

  it('passes a peer Wisp close reason to WASM without converting it to a normal close', async () => {
    const manager = new WasmTransportManager();
    const wasm = {
      createTransport: vi.fn(),
      injectTransportData: vi.fn(),
      closeTransport: vi.fn(),
      failTransport: vi.fn(),
    };
    const transport = {
      id: 'peer-wisp-close',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
    };
    manager.setWasm(wasm);

    await manager.register(transport);
    transport.onClose?.(new WispTransportCloseError(0x42));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(wasm.failTransport).toHaveBeenCalledWith('peer-wisp-close', 0x42);
    expect(wasm.closeTransport).not.toHaveBeenCalled();
  });
});
