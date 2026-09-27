import { access, readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';

test('package contains LunaSSH WASM assets', async () => {
  await access('dist/lunassh.wasm');
  await access('dist/wasm_exec.js');
});

test('compiled WASM does not expose build-machine paths', async () => {
  const wasm = await readFile('dist/lunassh.wasm', 'utf8');
  expect(wasm.match(/\/(?:home|Users)\/[^\s"'`]+/)?.[0]).toBeUndefined();
});
