# LunaSSH

`@nightnetwork/lunassh` provides browser-native SSH over Wisp, MoonBeam, or a supplied TCP provider (including MoonScale for Tailscale SSH). It is designed for applications that need an SSH session without browser TCP access.

The source package declares version `1.0.0`; this is not a claim that its release gates or live Wisp, MoonBeam, and Dusk smoke tests have passed. The source checkout's `docs/1.0-release-readiness.md` contains the prep checklist; that document is not part of the npm package.

## Installation

```sh
npm install @nightnetwork/lunassh
```

The root import (`@nightnetwork/lunassh`) and the `/next`, `/react`, and `/dusk` entries do not require both React and Vue to load. The `/vite` entry exports both React and Vue hooks and imports both frameworks eagerly, so install both optional peers (`react >=18` and `vue >=3`) before importing `@nightnetwork/lunassh/vite`, even if you use only one hook.

## WASM Asset

Copy the packaged browser assets into your application's public directory:

```sh
cp node_modules/@nightnetwork/lunassh/dist/lunassh.wasm public/assets/
cp node_modules/@nightnetwork/lunassh/dist/wasm_exec.js public/assets/
```

The installed asset paths are `node_modules/@nightnetwork/lunassh/dist/lunassh.wasm` and `node_modules/@nightnetwork/lunassh/dist/wasm_exec.js`. Serve the copied files from locations available to the browser, then initialize LunaSSH with their URLs.

## Direct Wisp

Use `SSHWispClient.connectViaWisp` for a direct browser connection to a Wisp endpoint.

```ts
import { SSHClient, SSHWispClient } from '@nightnetwork/lunassh';

await SSHClient.initialize({
  wasmPath: '/assets/lunassh.wasm',
  wasmExecPath: '/assets/wasm_exec.js',
});

const session = await SSHWispClient.connectViaWisp({
  wispUrl: 'wss://wisp.example/',
  host: 'ssh.example',
  port: 22,
  user: 'alice',
  password: 'example-only',
  // Replace with the SSH server's real OpenSSH host-key entry.
  knownHosts: ['ssh.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'],
});
```

## MoonBeam

Use `SSHWispClient.connectViaMoonbeam` when your application already owns a MoonBeam relay. LunaSSH attaches to that relay rather than opening a separate direct Wisp connection.

```ts
import { SSHClient, SSHWispClient } from '@nightnetwork/lunassh';

await SSHClient.initialize({
  wasmPath: '/assets/lunassh.wasm',
  wasmExecPath: '/assets/wasm_exec.js',
});

const session = await SSHWispClient.connectViaMoonbeam({
  host: 'ssh.example',
  port: 22,
  user: 'alice',
  // Replace with the SSH server's real OpenSSH host-key entry.
  knownHosts: ['ssh.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'],
}, moonbeamRelay);
```

## MoonScale and Tailscale SSH

For a tailnet SSH target, supply a connected MoonScale TCP client implementing `dialTcp(host, port)` to `connectViaMoonScaleTcp`, or use `connectViaProvider` when you need to cancel a pending connection. LunaSSH speaks SSH over that TCP socket; it does not establish the MoonScale connection or bypass Tailscale SSH policy. Initialize the WASM assets first as above, and verify the SSH host key independently of the tailnet transport.

```ts
import { SSHClient, SSHWispClient } from '@nightnetwork/lunassh';

await SSHClient.initialize({
  wasmPath: '/assets/lunassh.wasm',
  wasmExecPath: '/assets/wasm_exec.js',
});

const attempt = new AbortController();
const trustedCheckOrigins = new Set(['https://login.tailscale.com']); // Set your policy.
const session = await SSHWispClient.connectViaProvider({
  host: 'ssh.tailnet.example',
  port: 22,
  user: 'alice',
  knownHosts: ['ssh.tailnet.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'],
}, moonScaleTcpClient, {
  onAuthBanner(message) {
    // Check every SSH userauth banner; never open an untrusted link.
    for (const link of message.match(/https:\/\/[^\s]+/g) ?? []) {
      try {
        if (!trustedCheckOrigins.has(new URL(link).origin)) {
          attempt.abort();
          return;
        }
        showCheckLink(link);
      } catch {
        attempt.abort();
        return;
      }
    }
  },
}, { signal: attempt.signal });
```

The application owns `moonScaleTcpClient` and `showCheckLink`; configure the origin allowlist for your deployment before presenting or opening banner links. The callback fires for each SSH authentication banner, not just once. If the user cancels or a check is denied, call `attempt.abort()` while the handshake is pending and handle its `AbortError`; an established session instead needs `session.disconnect()`. `connectViaMoonScaleTcp` also accepts the same provider for connections that do not need an abort signal.

## Dusk Adapter

`@nightnetwork/lunassh/dusk` registers a streaming `ssh` command with Dusk's host-binary API.

```ts
import { registerSSHCommand } from '@nightnetwork/lunassh/dusk';

registerSSHCommand(processManager, {
  wispUrl: 'wss://wisp.example/',
  knownHosts: ['ssh.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...'],
  readFile: (path, cwd) => vfs.readFileText(path, cwd),
});
```

The command is:

```sh
ssh [-p PORT] [-l USER] [-i PRIVATE_KEY_PATH] host
```

Password authentication reads `DUSK_SSH_PASSWORD`. The `-i` option reads a private key through the configured VFS callback. Terminal output, stdin, and disconnect lifecycle are streamed through Dusk's generic host-binary contract.

## Security

Configure host-key verification with one of:

- `knownHosts`: minimal un-hashed OpenSSH entries;
- `hostKeyFingerprint`: SHA-256 or MD5 pin;
- `hostKey`: OpenSSH public-key pin.

`insecureSkipHostKeyVerification: true` explicitly disables verification and is intended only for development.
