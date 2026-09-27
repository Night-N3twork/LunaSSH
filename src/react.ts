/**
 * React specific utilities for LunaSSH.
 * 
 * Usage:
 * import { useSSHClient, SSHClient } from '@nightnetwork/lunassh/react';
 */

import { SSHClient, type InitializationOptions, type SSHSession, type ConnectionOptions, type SSHClientCallbacks } from './client';
import type { MoonbeamTransport } from './moonbeam-transport';
import type { WispTransport } from './wisp-transport';
import * as React from 'react';

export * from './index';

export async function initializeSSHClient(options: Partial<InitializationOptions> = {}): Promise<void> {
  await SSHClient.initialize(options);
}

/**
 * React hook for SSH client initialization
 */
export function useSSHClient(options: Partial<InitializationOptions> = {}) {
  const [isInitialized, setIsInitialized] = React.useState(false);
  const [initError, setInitError] = React.useState(null as Error | null);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let mounted = true;

    initializeSSHClient(options)
      .then(() => {
        if (mounted) {
          setIsInitialized(true);
          setInitError(null);
        }
      })
      .catch((error: Error) => {
        if (mounted) {
          setInitError(error);
          setIsInitialized(false);
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [JSON.stringify(options)]);

  return { isInitialized, initError, isLoading };
}

/**
 * React hook for managing SSH connections
 */
export function useSSHConnection() {
  const [session, setSession] = React.useState(null as SSHSession | null);
  const [connectionState, setConnectionState] = React.useState('idle' as 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected');
  const [connectionError, setConnectionError] = React.useState(null as Error | null);

  const connect = React.useCallback(async (
    options: ConnectionOptions, 
    transport: WispTransport | MoonbeamTransport,
    callbacks?: SSHClientCallbacks
  ) => {
    setConnectionState('connecting');
    setConnectionError(null);

    try {
      const enhancedCallbacks: SSHClientCallbacks = {
        ...callbacks,
        onStateChange: (state) => {
          setConnectionState(state === 'connected' ? 'connected' : 'connecting');
          callbacks?.onStateChange?.(state);
        }
      };

      const newSession = await SSHClient.connect(options, transport, enhancedCallbacks);
      setSession(newSession);
      setConnectionState('connected');
      return newSession;
    } catch (error) {
      setConnectionError(error as Error);
      setConnectionState('error');
      throw error;
    }
  }, []);

  const disconnect = React.useCallback(async () => {
    if (session) {
      try {
        await session.disconnect();
        setSession(null);
        setConnectionState('disconnected');
      } catch (error) {
        setConnectionError(error as Error);
        setConnectionState('error');
        throw error;
      }
    }
  }, [session]);

  const send = React.useCallback(async (data: Uint8Array) => {
    if (!session) {
      throw new Error('No active SSH session');
    }
    return session.send(data);
  }, [session]);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (session) {
        session.disconnect().catch(console.error);
      }
    };
  }, [session]);

  return {
    session,
    connectionState,
    connectionError,
    connect,
    disconnect,
    send
  };
}

/**
 * Higher-order component for SSH client initialization
 */
export function withSSHClient<P extends object>(
  Component: any, 
  options: Partial<InitializationOptions> = {}
) {
  return React.forwardRef<any, any>((props, ref) => {
    const { isInitialized, initError, isLoading } = useSSHClient(options);

    if (isLoading) {
      return React.createElement('div', null, 'Initializing SSH client...');
    }

    if (initError) {
      return React.createElement('div', null, `SSH initialization error: ${initError.message}`);
    }

    if (!isInitialized) {
      return React.createElement('div', null, 'SSH client not initialized');
    }

    return React.createElement(Component, { ...props, ref });
  });
}

/**
 * React context for SSH client
 */
export const SSHClientContext = React.createContext(null as {
  isInitialized: boolean;
  initError: Error | null;
  isLoading: boolean;
} | null);

/**
 * SSH client provider component
 */
export function SSHClientProvider({ 
  children, 
  options = {} 
}: { 
  children: any; 
  options?: Partial<InitializationOptions>;
}) {
  const sshState = useSSHClient(options);

  return React.createElement(
    SSHClientContext.Provider,
    { value: sshState },
    children
  );
}

/**
 * Hook to use SSH client context
 */
export function useSSHClientContext() {
  const context = React.useContext(SSHClientContext);
  if (!context) {
    throw new Error('useSSHClientContext must be used within an SSHClientProvider');
  }
  return context;
}

export default {
  initializeSSHClient,
  useSSHClient,
  useSSHConnection,
  withSSHClient,
  SSHClientProvider,
  SSHClientContext,
  useSSHClientContext,
  SSHClient
};
