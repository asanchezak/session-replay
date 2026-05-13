/** S05 — Recording across a tab navigation. */
import { test, expect, openTestPage, setRecordingState, pageUrl } from "./_helpers";

test("S05 — recording continues across navigation", async ({ page, context }) => {
  await openTestPage(page, "stable.html");
  await setRecordingState(page, true);
  await page.locator("#submit").click();

  // Navigate to a second page, then interact again.
  await page.goto(pageUrl("file-upload.html"));
  await page.waitForFunction(() => (window as any).__SR_CONTENT_SCRIPT__ === true, null, { timeout: 5000 }).catch(() => {});
  await page.locator("button[type=submit]").click();

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const len = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events?.length ?? 0;
  });
  expect(len).toBeGreaterThanOrEqual(2);
});
