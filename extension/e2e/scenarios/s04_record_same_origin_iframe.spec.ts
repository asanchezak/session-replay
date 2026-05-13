/** S04 — Recording within a same-origin iframe.
 *
 * The content script is injected on every frame (manifest `matches: <all_urls>`),
 * so the iframe should contribute events. We can't easily attribute frame
 * chains today; this test asserts that *some* event from the iframe is captured.
 */
import { test, expect, openTestPage, setRecordingState } from "./_helpers";

test.fixme("S04 — same-origin iframe captures events", async ({ page, context }) => {
  await openTestPage(page, "iframe-same-origin.html");
  await setRecordingState(page, true);

  const frame = page.frame({ name: undefined, url: /iframe-content\.html$/ });
  if (!frame) test.fail(true, "iframe did not load");
  await frame!.locator("#frame-input").click();
  await frame!.locator("#frame-input").fill("hello");

  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 5000 });
  const events = await sw.evaluate(async () => {
    const s = await new Promise<any>((r) => chrome.storage.session.get("recording_state", r));
    return s?.recording_state?.events ?? [];
  });
  // Expected enhancement: payload.frame_url or page_url ends with iframe-content.html.
  const fromFrame = events.find((e: any) => (e.page_url || "").includes("iframe-content"));
  expect(fromFrame).toBeDefined();
});
