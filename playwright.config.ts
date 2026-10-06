import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'web/test', testMatch: '*.spec.ts', workers: 1,
  use: { headless: true, launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {} },
  webServer: { command: 'npm run preview', url: 'http://127.0.0.1:4173', reuseExistingServer: true }, reporter: 'list' });
