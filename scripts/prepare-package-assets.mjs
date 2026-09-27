import { copyFile, mkdir } from 'node:fs/promises';

const assets = ['lunassh.wasm', 'wasm_exec.js'];

await mkdir('dist', { recursive: true });
await Promise.all(assets.map((asset) => copyFile(`public/${asset}`, `dist/${asset}`)));
