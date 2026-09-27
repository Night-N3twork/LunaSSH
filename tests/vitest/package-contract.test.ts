import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const nextEntry = readFileSync(new URL('../../src/next.ts', import.meta.url), 'utf8');
const viteEntry = readFileSync(new URL('../../src/vite.ts', import.meta.url), 'utf8');
const reactEntry = readFileSync(new URL('../../src/react.ts', import.meta.url), 'utf8');
const verifier = readFileSync(new URL('../../scripts/verify-package.mjs', import.meta.url), 'utf8');
const goMain = readFileSync(new URL('../../main.go', import.meta.url), 'utf8');

describe('package contract', () => {
  it('publishes LunaSSH through the supported package exports', () => {
    expect(packageJson.name).toBe('@nightnetwork/lunassh');
    expect(Object.keys(packageJson.exports)).toEqual([
      '.',
      './next',
      './vite',
      './react',
      './dusk',
      './package.json',
    ]);
  });

  it('ships Node-recognized ESM and CommonJS files for every supported entry', () => {
    expect(packageJson.module).toBe('dist/index.mjs');
    expect(packageJson.main).toBe('dist/index.cjs.js');
    for (const entry of ['index', 'next', 'vite', 'react', 'dusk']) {
      const key = entry === 'index' ? '.' : `./${entry}`;
      expect(packageJson.exports[key]).toEqual({
        types: `./dist/${entry}.d.ts`,
        import: `./dist/${entry}.mjs`,
        require: `./dist/${entry}.cjs.js`,
      });
      expect(packageJson.files).toContain(`dist/${entry}.mjs`);
      expect(packageJson.files).toContain(`dist/${entry}.cjs.js`);
      expect(packageJson.files).not.toContain(`dist/${entry}.esm.js`);
    }
  });

  it('loads the root entry in a consumer with neither React nor Vue installed', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'lunassh-consumer-'));
    try {
      const installed = join(fixture, 'node_modules', '@nightnetwork', 'lunassh');
      mkdirSync(join(installed, 'dist'), { recursive: true });
      copyFileSync(new URL('../../package.json', import.meta.url), join(installed, 'package.json'));
      for (const entry of ['index.mjs', 'index.cjs.js']) {
        copyFileSync(new URL(`../../dist/${entry}`, import.meta.url), join(installed, 'dist', entry));
      }
      for (const [args, expression] of [
        [['--input-type=module', '-e'], "import { SSHClient } from '@nightnetwork/lunassh'; if (!SSHClient) throw Error('missing root export')"],
        [['-e'], "if (!require('@nightnetwork/lunassh').SSHClient) throw Error('missing root export')"],
      ] as const) {
        const result = spawnSync(process.execPath, [...args, expression], { cwd: fixture, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps the bridge internal and framework entries as supported initializers', () => {
    expect(packageJson.exports).not.toHaveProperty('./bridge');
    expect(nextEntry).toContain('export async function initializeSSHClient');
    expect(viteEntry).toContain('export async function initializeSSHClient');
    expect(reactEntry).toContain('export async function initializeSSHClient');
  });

  it('keeps only the supported package dependencies and optional framework peers', () => {
    expect(packageJson.version).toBe('1.0.0');
    expect(packageJson).not.toHaveProperty('dependencies');
    expect(packageJson.optionalDependencies).toEqual({
      '@nightnetwork/moonbeam': '^1.0.1',
    });
    expect(Object.keys(packageJson.devDependencies).sort()).toEqual([
      '@nightnetwork/dusk',
      '@playwright/test',
      '@types/react',
      'react',
      'typescript',
      'vite',
      'vite-plugin-dts',
      'vitest',
      'vue',
    ]);
    expect(packageJson).not.toHaveProperty('dependencies');
    expect(packageJson.devDependencies).not.toHaveProperty('protobufjs-cli');
    expect(packageJson.peerDependencies).toMatchObject({
      '@nightnetwork/dusk': '^0.9.0 || ^1.0.0',
      react: '>=18.0.0',
      vue: '>=3.0.0',
    });
    expect(packageJson.peerDependenciesMeta).toEqual({
      '@nightnetwork/dusk': { optional: true },
      react: { optional: true },
      vue: { optional: true },
    });
    expect(packageJson.devDependencies['@nightnetwork/dusk']).toBe('^0.9.0');
  });

  it('publishes public packages', () => {
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
  });

  it('packs the full Apache 2.0 license for Night Network', () => {
    expect(packageJson.license).toBe('Apache-2.0');
    const output = execFileSync('pnpm', ['run', 'verify:pack'], { encoding: 'utf8' });
    const json = output.match(/(\[\s*\{[\s\S]*\])\s*$/)?.[1];
    if (!json) throw new Error('npm pack did not emit JSON output');
    const [{ files }] = JSON.parse(json);
    expect(files.map(({ path }: { path: string }) => path)).toContain('LICENSE.md');

    const license = readFileSync(new URL('../../LICENSE.md', import.meta.url), 'utf8');
    expect(license).toMatch(/Apache License\s+Version 2\.0, January 2004/);
    for (const section of [
      '1. Definitions.',
      '2. Grant of Copyright License.',
      '3. Grant of Patent License.',
      '4. Redistribution.',
      '5. Submission of Contributions.',
      '6. Trademarks.',
      '7. Disclaimer of Warranty.',
      '8. Limitation of Liability.',
      '9. Accepting Warranty or Additional Liability.',
      'END OF TERMS AND CONDITIONS',
      'APPENDIX: How to apply the Apache License to your work.',
    ]) {
      expect(license).toContain(section);
    }
    expect(license.length).toBeGreaterThan(10_000);
    expect(license).toContain('Copyright 2026 Night Network');
    expect(license).not.toMatch(/Verdigris|BSD 3-Clause|Redistribution and use in source and binary forms/i);
  }, 30_000);

  it('builds and verifies before packing while preserving publish validation', () => {
    expect(packageJson.scripts.prepack).toBe('pnpm run build && pnpm run verify:package');
    expect(packageJson.scripts.prepublishOnly).toBe('pnpm run verify:package');
    expect(packageJson.scripts['verify:pack']).toBe('npm pack --dry-run --json --ignore-scripts');
  });

  it('packs all supported runtime and declaration assets', () => {
    const output = execFileSync('pnpm', ['run', 'verify:pack'], { encoding: 'utf8' });
    const json = output.match(/(\[\s*\{[\s\S]*\])\s*$/)?.[1];
    if (!json) throw new Error('npm pack did not emit JSON output');
    const [{ files }] = JSON.parse(json);
    const packedPaths = files.map(({ path }: { path: string }) => path);

    expect(packedPaths).toEqual(expect.arrayContaining([
      'dist/index.cjs.js',
      'dist/index.mjs',
      'dist/index.d.ts',
      'dist/client.d.ts',
      'dist/bridge.d.ts',
      'dist/wisp-transport.d.ts',
      'dist/moonbeam-transport.d.ts',
      'dist/moonscale-transport.d.ts',
      'dist/provider-transport.d.ts',
      'dist/ssh-wisp-client.d.ts',
      'dist/lunassh.wasm',
      'dist/wasm_exec.js',
    ]));
    for (const entry of ['index', 'next', 'vite', 'react', 'dusk']) {
      expect(packedPaths).toContain(`dist/${entry}.mjs`);
      expect(packedPaths).toContain(`dist/${entry}.cjs.js`);
      expect(packedPaths).not.toContain(`dist/${entry}.esm.js`);
    }
  }, 30_000);

  it('verifies release artifacts and retired names before publication', () => {
    expect(() => execFileSync('node', ['scripts/verify-package.mjs'], { encoding: 'utf8' })).not.toThrow();
    expect(verifier).toContain('npm');
  });

  it.each([
    ['retired name', 'retired: aws-iot'],
    ['local path', '/home/amplify/Projects/NightShade/LunaSSH'],
    ['Windows local path', 'C:\\Users\\builder\\projects\\lunassh'],
    ['workspace local path', '/workspace/build/project'],
    ['repository marker', 'NightShade/LunaSSH'],
    ['private key', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['WASM embedded path', '/home/amplify/Projects/NightShade/LunaSSH', 'dist/lunassh.wasm'],
  ])('rejects %s in an untracked packed file outside git', (_kind, content, file = 'dist/notes.txt') => {
    const fixture = mkdtempSync(join(tmpdir(), 'lunassh-pack-'));
    try {
      mkdirSync(join(fixture, 'dist'));
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({
        name: 'lunassh-pack-fixture', version: '1.0.0',
        files: ['dist/index.js', 'dist/notes.txt', 'dist/lunassh.wasm', 'dist/wasm_exec.js'],
        exports: { '.': './dist/index.js' },
      }));
      writeFileSync(join(fixture, 'dist/index.js'), 'export const ready = true;');
      writeFileSync(join(fixture, 'dist/lunassh.wasm'), file === 'dist/lunassh.wasm' ? content : 'wasm');
      writeFileSync(join(fixture, 'dist/wasm_exec.js'), 'runtime');
      writeFileSync(join(fixture, 'README.md'), 'fixture package');
      writeFileSync(join(fixture, 'dist/notes.txt'), file === 'dist/notes.txt' ? content : 'notes');
      const result = spawnSync('node', [new URL('../../scripts/verify-package.mjs', import.meta.url).pathname], {
        cwd: fixture, encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(file);
      expect(result.stderr).toContain('packed');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('does not reject URLs and ordinary package asset paths as local paths', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'lunassh-pack-'));
    try {
      mkdirSync(join(fixture, 'dist'));
      writeFileSync(join(fixture, 'package.json'), JSON.stringify({
        name: 'lunassh-pack-fixture', version: '1.0.0',
        files: ['dist/index.js', 'dist/lunassh.wasm', 'dist/wasm_exec.js'],
        exports: { '.': './dist/index.js' },
      }));
      writeFileSync(join(fixture, 'dist/index.js'), 'export const asset = "https://example.test/workspace/assets/lunassh.wasm"; export const path = "/assets/lunassh.wasm";');
      writeFileSync(join(fixture, 'dist/lunassh.wasm'), 'wasm');
      writeFileSync(join(fixture, 'dist/wasm_exec.js'), 'runtime');
      const result = spawnSync('node', [new URL('../../scripts/verify-package.mjs', import.meta.url).pathname], { cwd: fixture, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('aligns the WASM version and documents secure MoonScale Tailscale SSH', () => {
    expect(goMain).toContain('return js.ValueOf("1.0.0")');
    expect(readme).toMatch(/MoonScale[\s\S]*Tailscale SSH/i);
    expect(readme).toContain('connectViaProvider');
    expect(readme).toContain('onAuthBanner');
    expect(readme).toContain('signal');
    expect(readme).toContain('knownHosts');
    expect(readme).toContain('new URL(link).origin');
    expect(readme).toContain('attempt.abort()');
  });

  it('initializes LunaSSH before the MoonBeam quick start connects', () => {
    expect(readme).toContain("import { SSHClient, SSHWispClient } from '@nightnetwork/lunassh';");
    expect(readme).toMatch(/## MoonBeam[\s\S]*await SSHClient\.initialize\(\{[\s\S]*wasmPath: '\/assets\/lunassh\.wasm'/);
  });
});
