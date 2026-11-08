import { defineConfig, devices } from '@playwright/test';

const databaseUrl = process.env.DATABASE_URL || 'postgres://slotbook:slotbook@localhost:5432/slotbook';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm start',
    url: 'http://127.0.0.1:3000/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: process.env.SESSION_SECRET || 'dev-only-change-me',
      NODE_ENV: 'production',
      PORT: '3000',
    },
  },
});
