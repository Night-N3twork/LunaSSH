import { describe, expect, it, vi } from 'vitest';
import { ProviderTransport } from '../../src/provider-transport';

describe('ProviderTransport', () => {
  it('consumes a generic TCP provider without a MoonScale dependency', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      }),
    };
    const provider = { dialTcp: vi.fn(async () => socket) };
    const transport = new ProviderTransport('provider-ssh', provider, { sshHost: '100.64.0.8', sshPort: 22 });
    const received: Uint8Array[] = [];
    transport.onData = (data) => received.push(data);

    await transport.connect();
    await transport.send(new Uint8Array([1]));
    listeners.get('data')!(new Uint8Array([2]));
    await transport.disconnect();

    expect(provider.dialTcp).toHaveBeenCalledWith('100.64.0.8', 22);
    expect(received).toEqual([new Uint8Array([2])]);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('unsubscribes socket listeners and ignores retained callbacks after disconnect', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
        const unsubscribe = vi.fn(() => listeners.delete(event));
        unsubscribes.set(event, unsubscribe);
        return unsubscribe;
      }),
    };
    const provider = { dialTcp: vi.fn(async () => socket) };
    const transport = new ProviderTransport('provider-ssh', provider, { sshHost: '100.64.0.8', sshPort: 22 });
    const onData = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    transport.onData = onData;
    transport.onError = onError;
    transport.onClose = onClose;

    await transport.connect();
    const dataListener = listeners.get('data')!;
    const errorListener = listeners.get('error')!;
    const closeListener = listeners.get('close')!;
    await transport.disconnect();

    expect(unsubscribes.get('data')).toHaveBeenCalledOnce();
    expect(unsubscribes.get('error')).toHaveBeenCalledOnce();
    expect(unsubscribes.get('close')).toHaveBeenCalledOnce();
    expect(listeners).toEqual(new Map());

    dataListener(new Uint8Array([2]));
    errorListener(new Error('retained'));
    closeListener();

    expect(onData).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('unsubscribes socket listeners and ignores retained callbacks after a remote close', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        listeners.set(event, listener);
        const unsubscribe = vi.fn(() => listeners.delete(event));
        unsubscribes.set(event, unsubscribe);
        return unsubscribe;
      }),
    };
    const transport = new ProviderTransport('provider-ssh', { dialTcp: vi.fn(async () => socket) }, { sshHost: '100.64.0.8', sshPort: 22 });
    const onData = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    transport.onData = onData;
    transport.onError = onError;
    transport.onClose = onClose;

    await transport.connect();
    const dataListener = listeners.get('data')!;
    const errorListener = listeners.get('error')!;
    listeners.get('close')!();

    expect(unsubscribes.get('data')).toHaveBeenCalledOnce();
    expect(unsubscribes.get('error')).toHaveBeenCalledOnce();
    expect(unsubscribes.get('close')).toHaveBeenCalledOnce();

    dataListener(new Uint8Array([2]));
    errorListener(new Error('retained'));

    expect(onData).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('unsubscribes registered listeners when connection setup fails', async () => {
    const listeners = new Map<string, (...args: any[]) => void>();
    const unsubscribes = new Map<string, ReturnType<typeof vi.fn>>();
    const socket = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (event === 'close') throw new Error('close listener failed');
        listeners.set(event, listener);
        const unsubscribe = vi.fn(() => listeners.delete(event));
        unsubscribes.set(event, unsubscribe);
        return unsubscribe;
      }),
    };
    const transport = new ProviderTransport('provider-ssh', { dialTcp: vi.fn(async () => socket) }, { sshHost: '100.64.0.8', sshPort: 22 });

    await expect(transport.connect()).rejects.toThrow('close listener failed');

    expect(unsubscribes.get('data')).toHaveBeenCalledOnce();
    expect(unsubscribes.get('error')).toHaveBeenCalledOnce();
    expect(listeners).toEqual(new Map());
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
