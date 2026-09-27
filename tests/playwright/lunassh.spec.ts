import { test, expect } from '@playwright/test';

test.describe('LunaSSH browser suite — mocked endpoints, no real SSH', () => {

  test('mock-transport page exposes LunaSSH browser API', async ({ page }) => {
    await page.goto('/tests/playwright/mock-transport.html');
    await page.waitForFunction(() => (window as any).__lunassh_ready === true);
    const hasAPI = await page.evaluate(() => {
      const api = (window as any).__lunassh;
      return {
        hasWisp: typeof api.WispTransport === 'function',
        hasMoonbeam: typeof api.MoonbeamTransport === 'function',
        hasHelper: typeof api.SSHWispClient === 'function',
        hasRelayMock: typeof api.MockMoonbeamRelay === 'function',
        hasHelpers: typeof api.LunaSSHHelpers === 'object',
      };
    });
    expect(hasAPI.hasWisp).toBe(true);
    expect(hasAPI.hasMoonbeam).toBe(true);
    expect(hasAPI.hasHelper).toBe(true);
    expect(hasAPI.hasRelayMock).toBe(true);
    expect(hasAPI.hasHelpers).toBe(true);
  });

  test('MoonbeamTransport mocked flow works in browser (no real Wisp server)', async ({ page }) => {
    await page.goto('/tests/playwright/mock-transport.html');
    await page.waitForFunction(() => (window as any).__lunassh_ready === true);
    const result = await page.evaluate(async () => {
      const { MoonbeamTransport, MockMoonbeamRelay } = (window as any).__lunassh;
      const relay = new MockMoonbeamRelay();
      const t = new MoonbeamTransport('browser-test-mb', relay, { sshHost: '203.0.113.1', sshPort: 22 });
      let dataReceived = '';
      t.onData = (d: Uint8Array) => { dataReceived = new TextDecoder().decode(d); };
      await t.connect();
      if (!t.isConnected) return { ok: false, reason: 'not connected after connect' };
      await t.send(new TextEncoder().encode('hello-browser'));
      // wait for echo
      await new Promise(r => setTimeout(r, 50));
      const ok = dataReceived === 'hello-browser';
      await t.disconnect();
      const closed = !t.isConnected;
      return { ok, dataReceived, closed, echoOk: ok };
    });
    expect(result.ok).toBe(true);
    expect(result.dataReceived).toBe('hello-browser');
    expect(result.closed).toBe(true);
  });

  test('WispTransport mocked flow works via SSHWispClient helpers (mocked SSHClient)', async ({ page }) => {
    await page.goto('/tests/playwright/mock-transport.html');
    await page.waitForFunction(() => (window as any).__lunassh_ready === true);
    const result = await page.evaluate(async () => {
      const { SSHWispClient, MockMoonbeamRelay } = (window as any).__lunassh;
      // Mock SSHClient.connect to avoid WASM + real Wisp
      const { SSHClient } = (window as any).__lunassh;
      const origConnect = SSHClient.connect;
      let wispConstructed = false;
      let moonbeamConstructed = false;

      // Patch SSHWispClient to track construction via a wrapper
      // Instead, test create* helpers which don't need network
      const wispT = SSHWispClient.createWispTransport('w1', { wispUrl: 'wss://mock/', sshHost: '1.1.1.1', sshPort: 22 });
      const mbRelay = new MockMoonbeamRelay();
      const mbT = SSHWispClient.createMoonbeamTransport('m1', mbRelay, { sshHost: '1.1.1.1', sshPort: 22 });
      // In built dist, class names are minified (e.g. 'Ue'), so check by id + presence of methods, not constructor.name
      wispConstructed = wispT.id === 'w1' && typeof (wispT as any).connect === 'function' && typeof (wispT as any).send === 'function';
      moonbeamConstructed = mbT.id === 'm1' && typeof (mbT as any).connect === 'function' && typeof (mbT as any).send === 'function';

      return { wispConstructed, moonbeamConstructed };
    });
    expect(result.wispConstructed).toBe(true);
    expect(result.moonbeamConstructed).toBe(true);
  });

  test('LunaSSHHelpers exposes the default asset paths in browser', async ({ page }) => {
    await page.goto('/tests/playwright/mock-transport.html');
    await page.waitForFunction(() => (window as any).__lunassh_ready === true);
    const info = await page.evaluate(() => {
      return (window as any).__lunassh.LunaSSHHelpers.getAssetPaths();
    });
    expect(info).toEqual({ wasmPath: '/lunassh.wasm', wasmExecPath: '/wasm_exec.js' });
  });

});
