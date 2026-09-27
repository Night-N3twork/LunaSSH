import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

test('web server serves the config directory without an absolute checkout path', async ({ request }) => {
  const config = readFileSync(resolve(__dirname, '../../playwright.config.ts'), 'utf8');
  expect(config).not.toContain('/home/amplify');
  expect(config).toMatch(/--directory \. --bind 127\.0\.0\.1/);

  const response = await request.get('/tests/playwright/mock-transport.html');
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain('MockMoonbeamRelay');
});
