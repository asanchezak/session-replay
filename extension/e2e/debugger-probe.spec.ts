/**
 * Probe: can chrome.debugger.attach succeed inside the extension while
 * Playwright is the CDP master? Determines whether E2E verification of the
 * trusted-click path is possible via Playwright at all.
 */
import { test, expect } from "./fixtures";

test("chrome.debugger.attach inside extension while Playwright runs", async ({ context, extensionId }) => {
  // Open a target tab the extension can attach to
  const page = await context.newPage();
  await page.goto("about:blank");
  await page.waitForTimeout(500);

  // Run probe code in the service worker via the popup
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`, { waitUntil: "domcontentloaded" });

  const result = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "about:blank" });
    const tab = tabs[0];
    if (!tab?.id) return { err: "no about:blank tab" };

    try {
      await chrome.debugger.attach({ tabId: tab.id }, "1.3");
      // Try to dispatch a no-op mouse move
      try {
        await chrome.debugger.sendCommand({ tabId: tab.id }, "Input.dispatchMouseEvent", {
          type: "mouseMoved", x: 10, y: 10, button: "none", buttons: 0,
        });
      } catch (e) {
        await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
        return { attached: true, dispatchErr: String(e) };
      }
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
      return { attached: true, dispatchOk: true };
    } catch (e) {
      return { attached: false, attachErr: String(e) };
    }
  });

  console.log("\n=== DEBUGGER PROBE RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("=============================\n");

  expect(result).toBeDefined();
});
