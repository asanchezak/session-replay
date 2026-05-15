/**
 * Shared helpers for scenario specs.
 *
 * Re-exports the extension test fixture (which loads the extension via
 * launchPersistentContext) and adds scenario-specific helpers:
 * - `openTestPage(page, slug)` — navigates to a local HTML fixture.
 * - `setRecordingState(page, bool)` — sets chrome.storage recording state via SW.
 */
import path from "path";
import { fileURLToPath } from "url";
import { test, expect, type TestFixtures } from "../fixtures";
import type { Page } from "@playwright/test";
export { test, expect };
export type { TestFixtures };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const PAGES_DIR = path.resolve(__dirname, "../helpers/test-pages");

export function pageUrl(slug: string): string {
  return "file://" + path.join(PAGES_DIR, slug);
}

export async function openTestPage(page: Page, slug: string): Promise<void> {
  await page.goto(pageUrl(slug));
  await page.waitForFunction(() => (window as any).__SR_CONTENT_SCRIPT__ === true, null, { timeout: 5000 }).catch(() => {});
}

export async function setRecordingState(page: Page, isRecording: boolean) {
  // Use the SW test bridge to call orchestrator.startRecording/stopRecording directly.
  // Direct storage writes don't update orchestrator._isRecording so events would be dropped.
  const ctx = page.context();
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker", { timeout: 8000 });
  if (isRecording) {
    await sw.evaluate(async () => {
      const fn = (self as unknown as Record<string, () => Promise<void>>).__SR_startRecording;
      if (fn) await fn();
    });
  } else {
    await sw.evaluate(async () => {
      const fn = (self as unknown as Record<string, () => Promise<void>>).__SR_stopRecording;
      if (fn) await fn();
    });
  }
}
