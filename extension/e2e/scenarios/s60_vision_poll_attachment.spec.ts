/**
 * Workstream B (vision) E2E: confirm the extension's CommandExecutor can
 * capture a viewport screenshot via chrome.tabs.captureVisibleTab and that
 * the result is a downscaled JPEG with non-trivial dimensions and bytes.
 *
 * The fixture is served from http://sr-test.local so the extension's host
 * permissions apply (captureVisibleTab needs activeTab/host access).
 */
import { test, expect } from "../fixtures";

const TEST_PAGE_URL = "http://sr-test.local/vision-modal";
const VISION_HTML = `<!DOCTYPE html>
<html>
<head><title>Vision E2E — consent banner</title>
<style>
  body { font-family: system-ui; padding: 24px; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 9999; }
  .consent { background: white; padding: 24px; border-radius: 8px; max-width: 480px; text-align: center; }
</style></head>
<body>
  <h1>Welcome to the Page</h1>
  <p>Below the overlay is the real content.</p>
  <a href="#next" id="continue-link">Continue</a>
  <div class="overlay" role="dialog" aria-label="Cookie consent" aria-modal="true">
    <div class="consent">
      <h2>We use cookies</h2>
      <p>Please accept cookies to continue.</p>
      <button id="accept-cookies">Accept All</button>
    </div>
  </div>
</body></html>`;

test("captureScreenshot: returns base64 JPEG with downscaled dimensions", async ({ context }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await page.route("**/sr-test.local/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: VISION_HTML });
  });
  await page.goto(TEST_PAGE_URL);
  await expect(page.getByRole("dialog", { name: /Cookie consent/i })).toBeVisible();
  // captureVisibleTab requires the target tab to be the active tab in its
  // window. Headless contexts can leave the about:blank tab focused.
  await page.bringToFront();

  const sw = context.serviceWorkers()[0]
    ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });

  const result = await sw.evaluate(async (pattern: string) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => (t.url ?? "").includes(pattern));
    if (!target?.id) return { __wrap: true, __error: "no tab matching " + pattern };
    const ce = (self as any).__SR_commandExecutor;
    if (!ce || typeof ce.captureScreenshot !== "function") {
      return { __wrap: true, __skip: "__SR_commandExecutor not exposed on SW global" };
    }
    // Ensure the target tab is active so captureVisibleTab can read it.
    try { await chrome.tabs.update(target.id, { active: true }); } catch { /* noop */ }
    const shot = await ce.captureScreenshot(target.id);
    if (!shot) return { __wrap: true, __error: "captureScreenshot returned null" };
    return shot;
  }, "sr-test.local/vision-modal");

  const r = result as any;
  if (r.__wrap && r.__skip) {
    test.skip(true, r.__skip);
    return;
  }
  if (r.__wrap && r.__error) {
    throw new Error(r.__error);
  }
  expect(r.mime).toBe("image/jpeg");
  expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(1280);
  expect(r.byte_size).toBeGreaterThan(1000);
  expect(typeof r.b64).toBe("string");
  expect(r.b64.length).toBeGreaterThan(1000);

  await page.close();
});
