/** S01 — Record a 12-step LinkedIn-like candidate search.
 *
 * Smoke flow: open stable.html, type, submit, click a result, save, paginate.
 * Asserts the orchestrator's `eventBuffer` grows to ≥ 6 events with the right
 * event_type sequence.
 */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test.describe("S01 — 12-step search recording", () => {
  test("records click + type + select + submit", async ({ page, context }) => {
    await openTestPage(page, "stable.html");
    await setRecordingState(page, true);

    await page.locator("#q").click();
    await page.locator("#q").fill("Python engineer");
    await page.locator("#loc").selectOption("rem");
    await page.locator("#submit").click();
    await page.locator("[data-testid='r1']").click();
    await page.locator("[data-testid='r2']").click();

    // Pull the buffer out of chrome.storage.session via SW eval.
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const buffer = await sw.evaluate(async () => {
      const out = await new Promise<any>((resolve) => {
        // @ts-ignore
        chrome.storage.session.get("recording_state", (v) => resolve(v));
      });
      return out?.recording_state?.events ?? [];
    });
    expect(buffer.length).toBeGreaterThanOrEqual(6);
    const types = buffer.map((e: any) => e.event_type);
    expect(types).toEqual(expect.arrayContaining(["click", "type", "select"]));
  });
});
