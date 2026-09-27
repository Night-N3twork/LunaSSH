import { wasmTransportManager } from './bridge';
import type { WasmTransport } from './bridge';

export interface ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  timeout?: number;
  knownHosts?: string[];
  hostKeyFingerprint?: string;
  hostKey?: string;
  insecureSkipHostKeyVerification?: boolean;
  trustOnFirstUse?: boolean;
}

export interface PacketMetadata {
  timestamp: number;
  direction: "send" | "receive";
  size: number;
  type?: string;
}

export interface SSHClientCallbacks {
  onPacketSend?: (data: Uint8Array, metadata: PacketMetadata) => void;
  onPacketReceive?: (data: Uint8Array, metadata: PacketMetadata) => void;
  onStateChange?: (state: SSHConnectionState) => void;
  /** Raw SSH userauth banner text received during the connection handshake. */
  onAuthBanner?: (message: string) => void;
  /** Plaintext bytes received from the remote terminal, not SSH transport packets. */
  onTerminalOutput?: (data: Uint8Array) => void;
}

export interface InitializationOptions {
  wasmPath?: string;
  wasmExecPath?: string;
  autoDetect?: boolean;
  publicDir?: string;
  cacheBusting?: boolean;
  timeout?: number;
}

export type SSHConnectionState =
  | "connecting"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "error";

export interface SSHSession {
  sessionId: string;
  send: (data: Uint8Array) => Promise<void>;
  disconnect: () => Promise<void>;
  resizeTerminal: (cols: number, rows: number) => Promise<void>;
}


// Asset path detection utilities
function detectFramework(): 'nextjs' | 'vite' | 'webpack' | 'generic' {
  if (typeof window === 'undefined') return 'generic';
  
  // Check for Next.js
  if ((window as any).__NEXT_DATA__ || (window as any).next) {
    return 'nextjs';
  }
  
  // Check for Vite
  if ((window as any).__vite_plugin_react_preamble_installed__) {
    return 'vite';
  }
  
  // Check for Webpack
  if ((window as any).__webpack_require__) {
    return 'webpack';
  }
  
  return 'generic';
}

function getAssetPaths(options: InitializationOptions): { wasmPath: string; wasmExecPath: string } {
  const framework = detectFramework();
  const publicDir = options.publicDir || '/';
  
  // Use explicit paths if provided
  if (options.wasmPath && options.wasmExecPath) {
    return {
      wasmPath: options.wasmPath,
      wasmExecPath: options.wasmExecPath
    };
  }
  
  // Auto-detect based on framework
  switch (framework) {
    case 'nextjs':
      return {
        wasmPath: options.wasmPath || `${publicDir}lunassh.wasm`,
        wasmExecPath: options.wasmExecPath || `${publicDir}wasm_exec.js`
      };
    case 'vite':
      return {
        wasmPath: options.wasmPath || `${publicDir}lunassh.wasm`,
        wasmExecPath: options.wasmExecPath || `${publicDir}wasm_exec.js`
      };
    default:
      return {
        wasmPath: options.wasmPath || `${publicDir}lunassh.wasm`,
        wasmExecPath: options.wasmExecPath || `${publicDir}wasm_exec.js`
      };
  }
}

// Helper function to dynamically load wasm_exec.js
async function loadWasmExecutor(wasmExecPath: string, timeout: number = 10000): Promise<void> {
  if (typeof window === 'undefined') return; // Server-side check
  
  if ((window as any).Go) return; // Already loaded
  
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = wasmExecPath;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load wasm_exec.js from ${wasmExecPath}`));
    
    // Add timeout
    const timeoutId = setTimeout(() => {
      reject(new Error(`Timeout loading wasm_exec.js from ${wasmExecPath}`));
    }, timeout);
    
    script.onload = () => {
      clearTimeout(timeoutId);
      resolve();
    };
    
    document.head.appendChild(script);
  });
}

// Helper function to test if assets are available
async function testAssetAvailability(wasmPath: string, wasmExecPath: string): Promise<{ wasmAvailable: boolean; wasmExecAvailable: boolean }> {
  const testFetch = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  };
  
  const [wasmAvailable, wasmExecAvailable] = await Promise.all([
    testFetch(wasmPath),
    testFetch(wasmExecPath)
  ]);
  
  return { wasmAvailable, wasmExecAvailable };
}

export class SSHClient {
  private static wasmInstance: any;
  private static initialized = false;
  private static initialization: Promise<void> | undefined;
  private static transportManager = wasmTransportManager;

  static async initialize(options: InitializationOptions = {}): Promise<void> {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('Initialization options must be an object');
    }
    if (this.initialized) return;
    if (this.initialization) return this.initialization;

    this.initialization = this.initializeOnce(options);
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private static async initializeOnce(options: InitializationOptions): Promise<void> {

    const initOptions: InitializationOptions = {
      autoDetect: true,
      cacheBusting: true,
      timeout: 10000,
      ...options,
    };

    try {
      // Get asset paths using auto-detection or explicit options
      const { wasmPath, wasmExecPath } = getAssetPaths(initOptions);

      // Test asset availability if auto-detection is enabled
      if (initOptions.autoDetect) {
        const { wasmAvailable, wasmExecAvailable } = await testAssetAvailability(wasmPath, wasmExecPath);
        
        if (!wasmAvailable) {
          throw new Error(`WASM file not found at ${wasmPath}. Please ensure lunassh.wasm is in your public directory.`);
        }
        
        if (!wasmExecAvailable) {
          throw new Error(`wasm_exec.js not found at ${wasmExecPath}. Please ensure wasm_exec.js is in your public directory.`);
        }
      }

      // Load wasm_exec.js dynamically
      await loadWasmExecutor(wasmExecPath, initOptions.timeout);

      // Check if Go runtime is available
      if (typeof (window as any).Go === "undefined") {
        throw new Error(
          `Go runtime not loaded. Failed to load wasm_exec.js from ${wasmExecPath}.`
        );
      }

      const go = new (window as any).Go();
      
      // Prepare fetch URL with optional cache busting
      let fetchUrl = wasmPath;
      if (initOptions.cacheBusting) {
        const cacheBuster = `?v=${Date.now()}&t=${new Date().getTime()}`;
        fetchUrl += cacheBuster;
      }

      const fetchOptions: RequestInit = initOptions.cacheBusting 
        ? {
            cache: "no-cache",
            headers: {
              "Cache-Control": "no-cache",
              Pragma: "no-cache",
            },
          }
        : {};

      const response = await fetch(fetchUrl, fetchOptions);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch WASM file: ${response.status} ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      const result = await WebAssembly.instantiate(buffer, go.importObject);

      go.run(result.instance);

      const deadline = Date.now() + initOptions.timeout!;
      while (!(window as any).SSHClient) {
        if (Date.now() >= deadline) {
          throw new Error('Timed out waiting for the WASM SSHClient runtime to become ready.');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      this.wasmInstance = (window as any).SSHClient;

      if (!this.wasmInstance) {
        throw new Error(
          "Failed to initialize WASM module - SSHClient not found on window. The WASM module may not have loaded correctly."
        );
      }

      this.transportManager.setWasm(this.wasmInstance);
      this.initialized = true;

      // Optional: Log version in development mode
      if ((globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'development') {
        console.log(`SSHClient WASM initialized successfully`);
        if (this.wasmInstance.version) {
          console.log(`Version: ${this.wasmInstance.version()}`);
        }
      }

    } catch (error) {
      this.initialized = false;
      
      // Provide helpful error messages
      if (error instanceof Error) {
        throw new Error(`SSHClient initialization failed: ${error.message}`);
      } else {
        throw new Error('SSHClient initialization failed with unknown error');
      }
    }
  }

  static async connect(
    options: ConnectionOptions,
    transport: WasmTransport,
    callbacks?: SSHClientCallbacks,
    /** Abort a pending attempt without affecting an established session. */
    connectOptions?: { signal?: AbortSignal },
  ): Promise<SSHSession> {
    if (!this.initialized) {
      throw new Error("SSHClient not initialized. Call initialize() first.");
    }

    const signal = connectOptions?.signal;
    const abortError = () => new DOMException('SSH connection aborted', 'AbortError');
    if (signal?.aborted) throw abortError();

    await this.transportManager.register(transport);

    let rejectAbort!: (error: Error) => void;
    const aborted = signal && new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      void this.transportManager.close(transport.id).catch(() => {});
      rejectAbort(abortError());
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    let session: any;
    let cleanedSession: any;
    const disconnectCancelledSession = (candidate: SSHSession) => {
      if (cleanedSession === candidate) return;
      cleanedSession = candidate;
      void Promise.resolve().then(() => candidate.disconnect()).catch(() => {});
    };
    try {
      if (signal?.aborted) throw abortError();
      await (aborted ? Promise.race([transport.connect(), aborted]) : transport.connect());
      if (signal?.aborted) throw abortError();

      const jsCallbacks = callbacks
        ? {
            onPacketSend: (data: any, metadata: any) => callbacks.onPacketSend?.(data, metadata),
            onPacketReceive: (data: any, metadata: any) => callbacks.onPacketReceive?.(data, metadata),
            onStateChange: callbacks.onStateChange,
            onAuthBanner: callbacks.onAuthBanner,
            onTerminalOutput: callbacks.onTerminalOutput,
          }
        : undefined;

      const pendingSession = this.wasmInstance.connect(options, transport.id, jsCallbacks);
      if (aborted) {
        // Closing the bridge wakes Go's handshake, but a completed session can still arrive late.
        void Promise.resolve(pendingSession).then((lateSession: SSHSession) => {
          if (signal?.aborted) disconnectCancelledSession(lateSession);
        }, () => {});
      }
      session = await (aborted ? Promise.race([pendingSession, aborted]) : pendingSession);
      if (signal?.aborted) {
        // The abort may have happened between the handshake settling and this continuation.
        disconnectCancelledSession(session);
        throw abortError();
      }
    } catch (error) {
      try {
        await this.transportManager.close(transport.id);
      } catch {
        // Preserve the connection failure after best-effort transport cleanup.
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    return {
      sessionId: session.sessionId,
      send: async (data: Uint8Array) => {
        await session.send(data);
      },
      disconnect: async () => {
        await session.disconnect();
        await this.transportManager.close(transport.id);
      },
      resizeTerminal: async (cols: number, rows: number) => {
        await session.resizeTerminal(cols, rows);
      },
    };
  }

  static async disconnect(sessionId: string): Promise<void> {
    if (!this.initialized) {
      throw new Error("SSHClient not initialized");
    }

    await this.wasmInstance.disconnect(sessionId);
  }

  static async send(sessionId: string, data: Uint8Array): Promise<void> {
    if (!this.initialized) {
      throw new Error("SSHClient not initialized");
    }

    await this.wasmInstance.send(sessionId, data);
  }

  static getVersion(): string {
    if (!this.initialized) {
      throw new Error("SSHClient not initialized");
    }

    return this.wasmInstance.version();
  }
}

// Framework-specific helpers
export const LunaSSHHelpers = {
  /**
   * Get recommended asset paths for the detected framework
   */
  getAssetPaths: (publicDir = '/') => getAssetPaths({ publicDir }),

  /**
   * Detect the current framework
   */
  detectFramework,

  /**
   * Test if WASM assets are available at the given paths
   */
  testAssetAvailability,

  /**
   * Next.js specific initialization helper
   */
  initializeForNextJS: async (options: Partial<InitializationOptions> = {}) => {
    return SSHClient.initialize({
      publicDir: '/',
      autoDetect: true,
      cacheBusting: (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === 'development',
      ...options
    });
  },

  /**
   * Vite specific initialization helper
   */
  initializeForVite: async (options: Partial<InitializationOptions> = {}) => {
    return SSHClient.initialize({
      publicDir: '/',
      autoDetect: true,
      cacheBusting: (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true,
      ...options
    });
  },

  /**
   * Generic initialization with sensible defaults
   */
  initializeWithDefaults: async (customOptions: Partial<InitializationOptions> = {}) => {
    const defaultOptions: InitializationOptions = {
      autoDetect: true,
      cacheBusting: true,
      timeout: 10000,
      publicDir: '/'
    };

    return SSHClient.initialize({ ...defaultOptions, ...customOptions });
  }
};

export default SSHClient;
