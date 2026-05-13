/** S08 — Record keyboard shortcuts (Tab, Enter, Cmd+K). */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test.fixme("S08 — keyboard shortcuts recorded", async ({ page, context }) => {
  await openTestPage(page, "keyboard-spa.html");
  await setRecordingState(page, true);

  await page.keyboard.press("Meta+K");
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const events = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events ?? [];
  });

  // Expected enhancement: a "key" or "keydown" action_type exists.
  const hasKey = events.some((e: any) => e.event_type === "key" || (e.payload?.modifiers ?? []).includes("meta"));
  expect(hasKey).toBe(true);
});
