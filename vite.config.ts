import { defineConfig } from 'vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig(({ command, mode }) => {
  if (command === 'serve') {
    // Development server configuration - serve all examples
    return {
      root: './', // Use project root
      server: {
        port: 5173,
        open: false,
      },
      publicDir: 'public', // Serve files from public directory
      resolve: {
        alias: {
          '/src': resolve(import.meta.dirname, 'src')
        }
      },
      test: {
        include: ['tests/vitest/**/*.test.ts']
      }
    };
  } else {
    // Build configuration
    return {
      build: {
        emptyOutDir: true,
        lib: {
          entry: {
            index: resolve(import.meta.dirname, 'src/index.ts'),
            next: resolve(import.meta.dirname, 'src/next.ts'),
            vite: resolve(import.meta.dirname, 'src/vite.ts'),
            react: resolve(import.meta.dirname, 'src/react.ts'),
            dusk: resolve(import.meta.dirname, 'src/dusk.ts')
          },
          name: 'SSHClient',
          fileName: (format, entryName) => format === 'es' ? `${entryName}.mjs` : `${entryName}.cjs.js`,
          formats: ['es', 'cjs']
        },
        rollupOptions: {
          external: ['react', 'vue', '@nightnetwork/dusk'],
          output: {
            exports: 'named'
          }
        },
        sourcemap: true,
        outDir: 'dist'
      },
      plugins: [
        dts({
          include: ['src/**/*.ts'],
          outDir: 'dist'
        })
      ],
      test: {
        globals: true,
        environment: 'jsdom',
        include: ['tests/vitest/**/*.test.ts']
      }
    };
  }
});
