import { test as base, chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { STEALTH_INIT } from "../src/shared/stealth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const EXT_PATH = path.resolve(__dirname, "..");

// Persistent profile dir under extension/.linkedin-e2e-profile/. When the
// session has accumulated cookies/IndexedDB/history across runs, LinkedIn's
// anti-bot is less likely to flag it as a brand-new automation session.
// Set SR_E2E_FRESH_PROFILE=1 to force a per-worker temp profile (useful for
// reproducing first-run behaviour).
const PERSISTENT_PROFILE_DIR = path.resolve(EXT_PATH, ".linkedin-e2e-profile");

function makeProfileDir(): { dir: string; ephemeral: boolean } {
  if (process.env.SR_E2E_FRESH_PROFILE === "1") {
    const dir = path.resolve(
      os.tmpdir(),
      `sr-e2e-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    return { dir, ephemeral: true };
  }
  if (!fs.existsSync(PERSISTENT_PROFILE_DIR)) {
    fs.mkdirSync(PERSISTENT_PROFILE_DIR, { recursive: true });
  }
  return { dir: PERSISTENT_PROFILE_DIR, ephemeral: false };
}

/**
 * Installs the shared, minimal stealth bundle (src/shared/stealth.mjs) — the
 * SAME init script the production drivers use, so this test fixture exercises
 * the real code path rather than a divergent copy. It patches only what
 * automation breaks (navigator.webdriver + permissions.query, masked via a
 * toString proxy) and leaves WebGL/plugins/CPU/locale to native Chrome so the
 * fingerprint stays internally consistent for the real machine.
 */
async function installStealthInitScript(context: BrowserContext): Promise<void> {
  await context.addInitScript(STEALTH_INIT);
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
    const { dir: PROFILE_DIR, ephemeral } = makeProfileDir();
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      // Real Chrome binary so the natural fingerprint (UA, Sec-CH-UA,
      // navigator.plugins, WebGL renderer, audio context entropy) matches
      // what real users carry. Falls back to chromium if Chrome isn't
      // installed via Playwright's channel resolution.
      channel: process.env.SR_E2E_CHANNEL || "chrome",
      headless: process.env.HEADLESS !== "false",
      viewport: { width: 1280, height: 720 },
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        "--no-sandbox",
        // Anti-bot stealth: hide navigator.webdriver and the "Chrome is
        // being controlled by automated test software" hint LinkedIn
        // fingerprints. Combined with ignoreDefaultArgs to drop
        // --enable-automation.
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    await installStealthInitScript(context);

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
    // Only clean up ephemeral (fresh-profile) directories. Persistent ones
    // are kept across runs to age the session.
    if (ephemeral) {
      try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
    }
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
