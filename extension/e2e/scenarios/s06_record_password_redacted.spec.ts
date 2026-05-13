/** S06 — Password fields are NOT captured in plaintext.
 *
 * Today the extension writes `payload.value` for every input including
 * `type="password"`. The test fails until the redaction lands.
 */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test("S06 — password value is redacted in event payload", async ({ page, context }) => {
  await openTestPage(page, "password-form.html");
  await setRecordingState(page, true);
  await page.locator("#user").fill("alice");
  await page.locator("#pw").fill("supersecret123!");
  await page.locator("#cc").fill("4111 1111 1111 1111");

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const events = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events ?? [];
  });

  const all = JSON.stringify(events);
  test.fail(
    all.includes("supersecret123!") || all.includes("4111 1111 1111 1111"),
    "BUG E-C-02: password / cc-number leaked to event payload",
  );
});
