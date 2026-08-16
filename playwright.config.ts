import { defineConfig, devices } from '@playwright/test';

/**
 * This image ships Chromium under a versioned directory and sets
 * PLAYWRIGHT_BROWSERS_PATH, but the bundled revision does not always match the
 * one this @playwright/test expects. Point at the binary that is actually here,
 * and let PW_CHROMIUM override it elsewhere.
 */
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    screenshot: 'only-on-failure',
    permissions: ['camera'],
  },
  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          executablePath: process.env.PW_CHROMIUM ?? CHROMIUM,
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--no-sandbox',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
