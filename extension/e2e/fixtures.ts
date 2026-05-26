import { test as base, chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";

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
 * Proxy-based stealth bundle. Masks the headless/automation fingerprint
 * vectors LinkedIn's anti-bot bundle reads — navigator.webdriver, plugins,
 * languages, permissions, window.chrome.runtime, WebGL renderer,
 * Notification.permission, hardwareConcurrency, deviceMemory — and pins
 * Function.prototype.toString so the patched functions still report
 * `[native code]`. Naive Object.defineProperty patches can be detected via
 * `someFn.toString().includes("native code")` checks; this version defeats
 * that by re-pointing Function.prototype.toString through a Proxy.
 */
async function installStealthInitScript(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      // -------- Function.prototype.toString — native-shape masking ---------
      const nativeToString = Function.prototype.toString;
      const toStringMap = new WeakMap<Function, string>();
      const proxiedToString = new Proxy(nativeToString, {
        apply(target, thisArg, args) {
          const canned = toStringMap.get(thisArg as Function);
          if (canned) return canned;
          return Reflect.apply(target, thisArg, args);
        },
      });
      Function.prototype.toString = proxiedToString;
      // Make the proxy itself look native too.
      toStringMap.set(proxiedToString, "function toString() { [native code] }");

      const maskNative = <T extends Function>(fn: T, name: string): T => {
        toStringMap.set(fn, `function ${name}() { [native code] }`);
        return fn;
      };

      // -------------------- navigator.webdriver ----------------------------
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
          configurable: true,
        });
      } catch { /* ignore */ }

      // -------------------- navigator.plugins ------------------------------
      // Real Chrome has 5 plugin entries by default (PDF-related).
      const pluginNames = [
        "PDF Viewer",
        "Chrome PDF Viewer",
        "Chromium PDF Viewer",
        "Microsoft Edge PDF Viewer",
        "WebKit built-in PDF",
      ];
      const fakePlugins = pluginNames.map((name) => ({
        name,
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
        length: 1,
        0: { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
      }));
      const pluginArrayProxy = new Proxy(fakePlugins, {
        get(target, prop) {
          if (prop === "length") return target.length;
          if (prop === "item") return (i: number) => target[i];
          if (prop === "namedItem") return (n: string) => target.find((p) => p.name === n);
          if (typeof prop === "string" && /^\d+$/.test(prop)) return target[Number(prop)];
          return Reflect.get(target, prop);
        },
      });
      try {
        Object.defineProperty(navigator, "plugins", {
          get: () => pluginArrayProxy,
          configurable: true,
        });
        Object.defineProperty(navigator, "mimeTypes", {
          get: () => [{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }],
          configurable: true,
        });
      } catch { /* ignore */ }

      // -------------------- navigator.languages ----------------------------
      try {
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
          configurable: true,
        });
      } catch { /* ignore */ }

      // -------------------- navigator.permissions.query --------------------
      // Headless returns "denied" for notifications; real Chrome returns
      // "default" until the user grants/denies. Wrap and lie.
      try {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        const patchedQuery = function query(p: PermissionDescriptor): Promise<PermissionStatus> {
          if ((p as { name?: string }).name === "notifications") {
            return Promise.resolve({
              state: "default" as PermissionState,
              name: "notifications",
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              dispatchEvent: () => true,
            } as unknown as PermissionStatus);
          }
          return originalQuery(p);
        };
        navigator.permissions.query = maskNative(patchedQuery, "query");
      } catch { /* ignore */ }

      // -------------------- window.chrome.runtime --------------------------
      try {
        const w = window as unknown as { chrome?: Record<string, unknown> };
        if (!w.chrome) w.chrome = {};
        if (!(w.chrome as { runtime?: unknown }).runtime) {
          (w.chrome as { runtime?: unknown }).runtime = {
            OnInstalledReason: {
              CHROME_UPDATE: "chrome_update",
              INSTALL: "install",
              SHARED_MODULE_UPDATE: "shared_module_update",
              UPDATE: "update",
            },
            OnRestartRequiredReason: {
              APP_UPDATE: "app_update",
              OS_UPDATE: "os_update",
              PERIODIC: "periodic",
            },
            PlatformArch: {
              ARM: "arm",
              ARM64: "arm64",
              MIPS: "mips",
              MIPS64: "mips64",
              X86_32: "x86-32",
              X86_64: "x86-64",
            },
            PlatformOs: {
              ANDROID: "android",
              CROS: "cros",
              LINUX: "linux",
              MAC: "mac",
              OPENBSD: "openbsd",
              WIN: "win",
            },
            RequestUpdateCheckStatus: {
              NO_UPDATE: "no_update",
              THROTTLED: "throttled",
              UPDATE_AVAILABLE: "update_available",
            },
          };
        }
      } catch { /* ignore */ }

      // -------------------- WebGL UNMASKED_RENDERER / VENDOR ---------------
      try {
        const origGetParameter = WebGLRenderingContext.prototype.getParameter;
        const patchedGetParameter = function getParameter(this: WebGLRenderingContext, p: number) {
          if (p === 37445) return "Intel Inc.";                  // UNMASKED_VENDOR_WEBGL
          if (p === 37446) return "Intel Iris OpenGL Engine";    // UNMASKED_RENDERER_WEBGL
          return origGetParameter.call(this, p);
        };
        WebGLRenderingContext.prototype.getParameter = maskNative(patchedGetParameter, "getParameter");
        if (typeof WebGL2RenderingContext !== "undefined") {
          const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
          const patchedGetParameter2 = function getParameter(this: WebGL2RenderingContext, p: number) {
            if (p === 37445) return "Intel Inc.";
            if (p === 37446) return "Intel Iris OpenGL Engine";
            return origGetParameter2.call(this, p);
          };
          WebGL2RenderingContext.prototype.getParameter = maskNative(patchedGetParameter2, "getParameter");
        }
      } catch { /* ignore */ }

      // -------------------- Notification.permission ------------------------
      try {
        if (typeof Notification !== "undefined") {
          Object.defineProperty(Notification, "permission", {
            get: () => "default",
            configurable: true,
          });
        }
      } catch { /* ignore */ }

      // -------------------- hardwareConcurrency / deviceMemory -------------
      try {
        Object.defineProperty(navigator, "hardwareConcurrency", {
          get: () => 8,
          configurable: true,
        });
      } catch { /* ignore */ }
      try {
        Object.defineProperty(navigator, "deviceMemory", {
          get: () => 8,
          configurable: true,
        });
      } catch { /* ignore */ }
    } catch (err) {
      console.warn("[stealth] init script error:", err);
    }
  });
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
