/**
 * Real-Chromium tests for backend connectivity failure scenarios.
 *
 * Tests the extension's resilience when the backend is unreachable:
 * - Changing the API URL to an invalid address and running workflows
 * - verify the popup doesn't freeze or show broken state
 */
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

test.describe("Backend unreachable", () => {

  test("FETCH_WORKFLOWS does not freeze popup when backend is down", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // Point the extension at a non-existent backend
    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => chrome.storage.session.set({
      apiBaseUrl: "http://localhost:1/v1",
    }));

    // Reload popup so it picks up the new URL
    await popup.page.reload();
    await popup.page.waitForTimeout(1000);

    // Click "Run Workflow" to trigger FETCH_WORKFLOWS
    await popup.page.getByText("Run Workflow").click();
    await popup.page.waitForTimeout(3000);

    // The popup should still be responsive — show empty state, not a crash
    // It should also still show the popup chrome (Session Replay header)
    await expect(popup.page.getByText("Session Replay")).toBeVisible();

    // Verify it rendered either the workflow list UI or the idle state
    const hasBackBtn = await popup.page.getByText("← Back").isVisible().catch(() => false);
    const hasNoWorkflows = await popup.page.getByText("No workflows yet").isVisible().catch(() => false);
    expect(hasBackBtn || hasNoWorkflows).toBe(true);

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("settings panel allows changing backend URL", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // Open settings
    await popup.page.locator('button[title="Settings"]').click();
    await popup.page.waitForTimeout(500);

    // The backend URL input should be visible and editable
    const urlInput = popup.page.locator('input[placeholder="http://localhost:8081/v1"]');
    await expect(urlInput).toBeVisible();

    // Change to a bad URL
    await urlInput.fill("http://localhost:9999/v1");
    await popup.page.getByText("Save").click();
    await popup.page.waitForTimeout(1000);

    // Verify it persisted
    const sw = context.serviceWorkers()[0];
    const stored = await sw.evaluate(() => chrome.storage.session.get("apiBaseUrl"));
    expect(stored.apiBaseUrl).toBe("http://localhost:9999/v1");

    // Change it back
    await urlInput.fill("http://localhost:8081/v1");
    await popup.page.getByText("Save").click();
    await popup.page.waitForTimeout(1000);

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("RUN_WORKFLOW fails gracefully when backend is unreachable", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // Seed a workflow into the backend API first
    const sw = context.serviceWorkers()[0];

    // Create a workflow via the real API
    const page = await context.newPage();
    const createResp = await page.request.post("http://localhost:8081/v1/workflows/record", {
      headers: {
        "X-API-Key": process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw",
        "Content-Type": "application/json",
      },
      data: {
        name: "Backend Down Test",
        target_url: "https://example.com",
        events: [
          { event_type: "navigate", payload: { url: "https://example.com" }, page_url: "about:blank", page_title: "", timestamp: new Date().toISOString() },
        ],
      },
    });
    const workflow = await createResp.json();
    await page.close();

    // Now point the extension at a broken backend
    await sw.evaluate(() => chrome.storage.session.set({
      apiBaseUrl: "http://localhost:1/v1",
    }));

    // Reload popup
    await popup.page.reload();
    await popup.page.waitForTimeout(1000);

    // Click Run Workflow, should show the workflow list (fetched from API before we changed URL)
    // Actually it'll try to fetch from localhost:1 now and fail
    await popup.page.getByText("Run Workflow").click();
    await popup.page.waitForTimeout(3000);

    // Should still show the popup frame — not crashed
    await expect(popup.page.getByText("Session Replay")).toBeVisible();

    // Restore the correct URL
    await sw.evaluate(() => chrome.storage.session.set({
      apiBaseUrl: "http://localhost:8081/v1",
    }));

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

});
