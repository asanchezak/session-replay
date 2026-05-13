/** S07 — File-upload step is captured (path stripped to filename only). */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";
import path from "path";

test.fixme("S07 — file-upload event captured", async ({ page, context }) => {
  await openTestPage(page, "file-upload.html");
  await setRecordingState(page, true);

  // Set a fake file via Playwright's setInputFiles.
  const fixture = path.resolve(__dirname, "../helpers/test-pages/stable.html"); // any real path
  await page.locator("#file").setInputFiles(fixture);

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const events = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events ?? [];
  });

  const fileEv = events.find((e: any) => e.event_type === "type" || e.event_type === "click");
  expect(fileEv).toBeTruthy();
  // No absolute path should leak.
  const str = JSON.stringify(events);
  expect(str).not.toMatch(/\/Users\/|C:\\\\|home\//);
});
