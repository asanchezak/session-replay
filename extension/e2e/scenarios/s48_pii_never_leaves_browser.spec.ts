/** S48 — PII never leaves the browser (end-to-end). */
import { test, openTestPage, setRecordingState } from "./_helpers";

test("S48 — fake SSN typed during recording is redacted before transit", async ({ page, context }) => {
  await openTestPage(page, "password-form.html");
  await setRecordingState(page, true);
  await page.locator("#ssn").fill("123-45-6789");

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const events = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events ?? [];
  });
  const str = JSON.stringify(events);
  test.fail(
    str.includes("123-45-6789"),
    "BUG E-C-02: SSN leaked to event payload (redaction only happens in DOM snippets).",
  );
});
