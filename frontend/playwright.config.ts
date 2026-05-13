import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  fullyParallel: true,
  workers: process.env.CI ? 1 : 2,
  use: {
    headless: process.env.HEADLESS !== "false",
    baseURL: process.env.FRONTEND_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: { width: 1280, height: 800 },
  },
  webServer: process.env.SKIP_WEBSERVER
    ? undefined
    : {
        command: "npx vite --host 0.0.0.0",
        url: "http://localhost:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
