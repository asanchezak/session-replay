/**
 * Shared helpers for scenario specs.
 *
 * Re-exports the existing `test`/`expect` fixture and adds:
 * - `openTestPage(page, slug)` — serves the HTML fixture as a file URL.
 * - `withRecording(test, fn)` — flips recording on/off through chrome.storage.session.
 *
 * Tests live under `extension/e2e/scenarios/` once merged.
 */
import path from "path";
import { fileURLToPath } from "url";
import { test as base, expect, type Page } from "@playwright/test";
export { expect };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
// When merged, helpers/test-pages lives next to the scenarios dir's parent.
const PAGES_DIR = path.resolve(__dirname, "../helpers/test-pages");

export const test = base;

export function pageUrl(slug: string): string {
  return "file://" + path.join(PAGES_DIR, slug);
}

export async function openTestPage(page: Page, slug: string): Promise<void> {
  await page.goto(pageUrl(slug));
  await page.waitForFunction(() => (window as any).__SR_CONTENT_SCRIPT__ === true, null, { timeout: 5000 }).catch(() => {});
}

export async function setRecordingState(page: Page, isRecording: boolean) {
  await page.evaluate((v) => {
    return new Promise<void>((resolve) => {
      // @ts-ignore
      chrome.storage.session.set({ recording_state: { isRecording: v, events: [], name: "" } }, () => resolve());
    });
  }, isRecording);
}
