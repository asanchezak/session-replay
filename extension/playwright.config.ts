import { defineConfig } from "@playwright/test";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
export const EXT_PATH = resolve(__dirname);

export default defineConfig({
  testDir: "./e2e",
  timeout: 120000,
  retries: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 1 : 2,

  use: {
    headless: process.env.HEADLESS !== "false",
    channel: "chromium",
    viewport: { width: 1280, height: 720 },
    screenshot: "on",
    video: "on-first-retry",
    trace: "on-first-retry",
    contextOptions: {
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        "--no-sandbox",
      ],
    },
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
