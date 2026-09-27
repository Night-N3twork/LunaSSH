import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const { stdout } = await exec('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
const [pack] = JSON.parse(stdout);
const packed = new Set(pack.files.map(({ path }) => path));
const exportTargets = new Set();

function collectTargets(value) {
  if (typeof value === 'string') exportTargets.add(value.replace(/^\.\//, ''));
  else if (value && typeof value === 'object') {
    for (const target of Object.values(value)) collectTargets(target);
  }
}

collectTargets(pkg.exports);
for (const target of exportTargets) {
  if (!packed.has(target)) throw new Error(`export target missing from packed files: ${target}`);
}
for (const asset of ['dist/lunassh.wasm', 'dist/wasm_exec.js']) {
  if (!packed.has(asset) || !(await stat(asset)).size) {
    throw new Error(`missing or empty packed runtime asset: ${asset}`);
  }
}

const forbidden = [
  ['retired name', /aws-iot|securetunnel|sshclient-wasm|sshclient\.wasm/i],
  ['local path', /(?<![\w/:])\/(?:home|Users|workspace|workspaces|tmp|mnt|builds)\/[A-Za-z0-9_.-][^\s"'`<>]*|(?<![\w/\\])[A-Za-z]:[\\/][A-Za-z0-9_. -]+[\\/][A-Za-z0-9_. -]+|\bNightShade[\\/]LunaSSH\b/i],
  ['private key', /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/],
  ['credential token', /\b(?:npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{36,})\b/],
];

for (const path of packed) {
  const content = await readFile(path, 'utf8');
  for (const [kind, pattern] of forbidden) {
    if (pattern.test(content)) throw new Error(`${kind} found in packed file ${path}`);
  }
}
