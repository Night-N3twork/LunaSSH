/**
 * Vite specific initialization and utilities for LunaSSH.
 * 
 * Usage:
 * import { initializeSSHClient, SSHClient } from '@nightnetwork/lunassh/vite';
 */

import { SSHClient, type InitializationOptions } from './client';
import * as React from 'react';
import * as Vue from 'vue';

export * from './index';

/**
 * Initialize SSH client with Vite optimized defaults
 */
export function getViteInitializationOptions(options: Partial<InitializationOptions> = {}): InitializationOptions {
  return {
    publicDir: '/',
    autoDetect: true,
    cacheBusting: (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true,
    timeout: 10000,
    ...options,
  };
}

export async function initializeSSHClient(options: Partial<InitializationOptions> = {}): Promise<void> {
  return SSHClient.initialize(getViteInitializationOptions(options));
}

/**
 * Vite configuration helpers
 */
export const ViteConfig = {
  /**
   * Get recommended Vite server configuration for WASM support
   */
  getServerConfig() {
    return {
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
      // Ensure WASM files are served with correct MIME type
      middlewares: []
    };
  },

  /**
   * Get recommended Vite build configuration for WASM support
   */
  getBuildConfig() {
    return {
      target: 'esnext',
      rollupOptions: {
        output: {
          // Ensure WASM files are handled properly
          assetFileNames: (assetInfo: any) => {
            if (assetInfo.name?.endsWith('.wasm')) {
              return '[name][extname]';
            }
            return '[name].[hash][extname]';
          }
        }
      }
    };
  },

  /**
   * Get recommended Vite optimizeDeps configuration
   */
  getOptimizeDepsConfig() {
    return {
      exclude: ['@nightnetwork/lunassh']
    };
  },

  /**
   * Complete Vite configuration object
   */
  getViteConfig(customConfig: any = {}) {
    const serverConfig = this.getServerConfig();
    const buildConfig = this.getBuildConfig();
    const optimizeDepsConfig = this.getOptimizeDepsConfig();

    const { server = {}, build = {}, optimizeDeps = {}, ...remainingConfig } = customConfig;
    const requiredOutput = buildConfig.rollupOptions.output;
    const consumerOutput = build.rollupOptions?.output ?? {};
    const consumerAssetFileNames = consumerOutput.assetFileNames;

    return {
      ...remainingConfig,
      server: {
        ...serverConfig,
        ...server,
        headers: { ...serverConfig.headers, ...server.headers },
      },
      build: {
        ...buildConfig,
        ...build,
        rollupOptions: {
          ...buildConfig.rollupOptions,
          ...build.rollupOptions,
          output: {
            ...requiredOutput,
            ...consumerOutput,
            assetFileNames: (assetInfo: any) => requiredOutput.assetFileNames(assetInfo) === '[name][extname]'
              ? '[name][extname]'
              : typeof consumerAssetFileNames === 'function'
                ? consumerAssetFileNames(assetInfo)
                : consumerAssetFileNames ?? requiredOutput.assetFileNames(assetInfo),
          },
        },
      },
      optimizeDeps: {
        ...optimizeDepsConfig,
        ...optimizeDeps,
        exclude: [...new Set([...(optimizeDepsConfig.exclude ?? []), ...(optimizeDeps.exclude ?? [])])],
      },
    };
  }
};

/**
 * React hook for SSH client initialization in Vite
 */
export function useSSHClient(options: Partial<InitializationOptions> = {}) {
  if (!React) {
    throw new Error('React is not available. Please install React to use useSSHClient.');
  }

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
 * Vue composition API composable for SSH client initialization
 */
export function useSSHClientVue(options: Partial<InitializationOptions> = {}) {
  const isInitialized = Vue.ref(false);
  const initError = Vue.ref(null as Error | null);
  const isLoading = Vue.ref(true);

  Vue.onMounted(async () => {
    try {
      await initializeSSHClient(options);
      isInitialized.value = true;
      initError.value = null;
    } catch (error) {
      initError.value = error as Error;
      isInitialized.value = false;
    } finally {
      isLoading.value = false;
    }
  });

  return { 
    isInitialized: Vue.readonly(isInitialized), 
    initError: Vue.readonly(initError), 
    isLoading: Vue.readonly(isLoading) 
  };
}

export default {
  initializeSSHClient,
  ViteConfig,
  useSSHClient,
  useSSHClientVue,
  SSHClient
};
