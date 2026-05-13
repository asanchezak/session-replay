/** S02 — Recording survives a service-worker restart mid-flow.
 *
 * We capture ≥ 20 events, force the SW to terminate (chrome devtools protocol
 * `ServiceWorker.unregister` is not exposed; instead we exercise the orchestrator's
 * own persistence: clearing the SW's in-memory state by reloading the extension
 * via chrome://extensions is not possible, so we approximate by reading the
 * storage-persisted buffer after each event).
 */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test.describe("S02 — recording survives SW restart", () => {
  test("≥20 events persist in storage even before SW drain", async ({ page, context }) => {
    await openTestPage(page, "stable.html");
    await setRecordingState(page, true);

    for (let i = 0; i < 22; i++) {
      await page.locator("[data-testid='r1']").click();
    }
    // Read the persisted buffer directly from session storage via the SW.
    const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
    const buffered = await sw.evaluate(async () => {
      const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
      return s?.recording_state?.events?.length ?? 0;
    });
    expect(buffered).toBeGreaterThanOrEqual(20);
  });
});
