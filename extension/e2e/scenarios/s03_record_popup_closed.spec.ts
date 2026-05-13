/** S03 — Recording with the extension popup closed (background-only capture). */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test("S03 — background-only capture works without the popup open", async ({ page, context }) => {
  await openTestPage(page, "stable.html");
  await setRecordingState(page, true);

  // Don't open chrome-extension://.../popup.html; just interact with the page.
  await page.locator("#submit").click();

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const len = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events?.length ?? 0;
  });
  expect(len).toBeGreaterThanOrEqual(1);
});
