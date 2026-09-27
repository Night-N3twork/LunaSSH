import { describe, expect, it, vi } from 'vitest';
import { MoonScaleTransport } from '../../src/moonscale-transport';

describe('MoonScaleTransport', () => {
  it('dials the SSH target through MoonScale TCP and forwards the socket lifecycle', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      }),
    };
    const dialTcp = vi.fn().mockResolvedValue(socket);
    const transport = new MoonScaleTransport('tailnet-ssh', { dialTcp }, { sshHost: '100.64.0.10', sshPort: 22 });
    const received: Uint8Array[] = [];
    const closed = vi.fn();
    transport.onData = (data) => received.push(data);
    transport.onClose = closed;

    await transport.connect();
    await transport.send(new Uint8Array([1, 2, 3]));
    listeners.get('data')!(new Uint8Array([4, 5]));
    listeners.get('close')!();

    expect(dialTcp).toHaveBeenCalledWith('100.64.0.10', 22);
    expect(socket.send).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(received).toEqual([new Uint8Array([4, 5])]);
    expect(closed).toHaveBeenCalledOnce();
    expect(transport.isConnected).toBe(false);
  });
});
