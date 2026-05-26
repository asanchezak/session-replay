import { test as base, chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const EXT_PATH = path.resolve(__dirname, "..");

// Use a unique temp profile per worker to avoid lock contention
function makeProfileDir(): string {
  const dir = path.resolve(os.tmpdir(), `sr-e2e-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  return dir;
}

export type ErrorEntry = {
  type: "console" | "exception" | "network" | "rejection" | "sw";
  text: string;
  url?: string;
  timestamp: number;
};

export type TestFixtures = {
  context: BrowserContext;
  extensionId: string;
  errors: ErrorEntry[];
  swContext: { sw: any; url: string };
};

export const test = base.extend<TestFixtures>({
  context: async ({}, use, testInfo) => {
    const PROFILE_DIR = makeProfileDir();
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chromium",
      headless: process.env.HEADLESS !== "false",
      viewport: { width: 1280, height: 720 },
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        "--no-sandbox",
        // Anti-bot stealth: hide navigator.webdriver and the
        // "Chrome is being controlled by automated test software" hint that
        // LinkedIn's anti-automation fingerprints. Combined with
        // ignoreDefaultArgs below to drop --enable-automation.
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    // Patch navigator.webdriver to "undefined" on every new document so
    // LinkedIn's anti-bot bundle can't read it as `true`.
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
          configurable: true,
        });
      } catch {
        /* ignore */
      }
    });

    await use(context);

    if (testInfo.status !== "passed") {
      const pages = context.pages();
      for (const p of pages) {
        try {
          await p.screenshot({ path: testInfo.outputPath(`failure-${pages.indexOf(p)}.png`) });
        } catch {}
      }
    }

    await context.close();
    // Clean up profile dir
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const id = sw.url().split("/")[2];
    await use(id);
  },

  errors: async ({ context, page }: { context: BrowserContext; page: Page }, use) => {
    const errors: ErrorEntry[] = [];
    const now = () => Date.now();

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push({
          type: "console",
          text: msg.text(),
          url: msg.location().url,
          timestamp: now(),
        });
      }
    });

    page.on("pageerror", (err) => {
      errors.push({
        type: "exception",
        text: err.message,
        url: err.stack,
        timestamp: now(),
      });
    });

    page.on("requestfailed", (req) => {
      errors.push({
        type: "network",
        text: `${req.url()} — ${req.failure()?.errorText || "Unknown"}`,
        url: req.url(),
        timestamp: now(),
      });
    });

    await page.evaluate(() => {
      window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
        console.error("UNHANDLED_REJECTION:", (e.reason as Error)?.message || String(e.reason));
      });
    });

    context.on("serviceworker", (sw) => {
      errors.push({
        type: "sw",
        text: `SW event: ${sw.url()}`,
        url: sw.url(),
        timestamp: now(),
      });
    });

    await use(errors);

    if (errors.length > 0) {
      console.log(`\n  ⚠ ${errors.length} errors during test:`);
      for (const e of errors.slice(0, 10)) {
        console.log(`    ${e.type}: ${e.text.slice(0, 250)}`);
      }
    }
  },
});

export { expect };
