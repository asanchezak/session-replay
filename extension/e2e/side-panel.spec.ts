/**
 * Real-Chromium tests for the extension side panel (panel.html).
 *
 * The side panel is an expanded view that shows step timeline, event
 * details, and quick actions. This test verifies it renders without
 * JavaScript errors in the actual extension context.
 */
import { test, expect } from "./fixtures";

test.describe("Side panel", () => {

  test("panel.html renders without console errors", async ({ context, extensionId, errors }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dist/panel.html`);
    await page.waitForTimeout(2000);

    // Panel should load without crashing
    await expect(page.locator("body")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await page.close();
  });

  test("panel.html has the expected structure", async ({ context, extensionId, errors }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/dist/panel.html`);
    await page.waitForTimeout(2000);

    // The panel should have a root element
    const rootEl = page.locator("#root, #app, div[data-panel]");
    await expect(rootEl.first()).toBeVisible({ timeout: 5000 });

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await page.close();
  });

});
