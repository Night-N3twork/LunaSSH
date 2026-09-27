import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NextJSConfig } from '../../src/next';
import { getViteInitializationOptions, ViteConfig } from '../../src/vite';
import viteConfig from '../../vite.config';

describe('framework configuration', () => {
  it('does not open a removed example page in development', () => {
    const config = viteConfig({ command: 'serve', mode: 'development' }) as any;
    expect(config.server.open).toBe(false);
  });

  it('merges Next consumer webpack and headers with LunaSSH requirements', async () => {
    const config = NextJSConfig.getNextConfig({
      webpack: (webpack: any) => ({
        ...webpack,
        experiments: { ...webpack.experiments, consumerExperiment: true },
        consumerWebpackOption: true,
      }),
      headers: async () => [{ source: '/custom', headers: [{ key: 'X-Consumer', value: 'true' }] }],
    });

    expect(config.webpack({ experiments: { topLevelAwait: true } })).toMatchObject({
      consumerWebpackOption: true,
      experiments: {
        topLevelAwait: true,
        consumerExperiment: true,
        asyncWebAssembly: true,
        layers: true,
      },
    });
    await expect(config.headers()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: '/(.*)' }),
      expect.objectContaining({ source: '/custom' }),
    ]));
  });

  it('merges Vite consumer sections with LunaSSH requirements', () => {
    const config = ViteConfig.getViteConfig({
      server: { host: '127.0.0.1', headers: { 'X-Consumer': 'true' } },
      build: {
        sourcemap: false,
        rollupOptions: { output: { chunkFileNames: 'chunks/[name].js' } },
      },
      optimizeDeps: { include: ['consumer-dependency'], exclude: ['consumer-exclusion'] },
    });

    expect(config.server).toMatchObject({
      host: '127.0.0.1',
      headers: {
        'X-Consumer': 'true',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    });
    expect(config.build).toMatchObject({ target: 'esnext', sourcemap: false });
    expect(config.build.rollupOptions.output.chunkFileNames).toBe('chunks/[name].js');
    expect(config.build.rollupOptions.output.assetFileNames({ name: 'lunassh.wasm' })).toBe('[name][extname]');
    expect(config.optimizeDeps.include).toEqual(['consumer-dependency']);
    expect(config.optimizeDeps.exclude).toEqual(expect.arrayContaining([
      '@nightnetwork/lunassh',
      'consumer-exclusion',
    ]));
  });

  it('enables cache busting for Vite development initialization', () => {
    expect(getViteInitializationOptions().cacheBusting).toBe(true);
  });
});

describe('built ESM framework entries', () => {
  it('imports all supported ESM entries without CommonJS in browser/framework entries', async () => {
    const entries = ['index', 'next', 'vite', 'react', 'dusk'];

    for (const entry of entries) {
      const path = `dist/${entry}.mjs`;
      const source = await readFile(path, 'utf8');
      if (entry !== 'dusk') expect(source).not.toContain('require(');
      const module = await import(`${pathToFileURL(path).href}?entry=${entry}`);
      expect(module).toHaveProperty(entry === 'index' ? 'SSHClient' : entry === 'dusk' ? 'createDuskSshAdapter' : 'initializeSSHClient');
    }
  });
});
