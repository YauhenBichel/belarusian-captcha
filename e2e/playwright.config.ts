// Playwright end-to-end tests (docs/DESIGN.md section 8.2): the verify API from source and the
// built demo page, in Chromium. Build first: `npm run build && npm run build:demo`, then
// `npm run e2e`. Both servers are started here and stopped after the run.

import { defineConfig, devices } from '@playwright/test';
import { API, API_PORT, DEMO, DEMO_PORT } from './env.js';

// A throwaway all-zero key ('A' x 43 in base64url), as in scripts/docker-smoke.sh: not a secret.
const TEST_KEYS = JSON.stringify({ active: 'k1', keys: { k1: 'A'.repeat(43) } });

export default defineConfig({
  testDir: '.',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: DEMO,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server/dist/main.js',
      cwd: '..',
      url: `${API}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        BC_SITES: 'e2e/sites.e2e.yaml',
        BC_KEYS: TEST_KEYS,
        BC_PACK: 'server/test/fixtures/synthetic-pack.json',
        BC_STORE: 'sqlite::memory:',
        BC_HOST: '127.0.0.1',
        BC_PORT: String(API_PORT),
        BC_METRICS_PORT: '0',
        BC_LOG_LEVEL: 'warn',
      },
    },
    {
      command: 'node demo/serve.mjs',
      cwd: '..',
      url: `${DEMO}/`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: { HOST: '127.0.0.1', PORT: String(DEMO_PORT) },
    },
  ],
});
