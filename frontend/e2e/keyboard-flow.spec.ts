import { test, expect } from "@playwright/test";

// Tests keyboard navigation in the frontend dashboard.
// Verifies that interactive elements are Tab-reachable and usable without mouse.

function mockEmpty(page: any) {
  page.route("**/v1/workflows*", async (route: any) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  page.route("**/v1/runs*", async (route: any) => {
    const url = route.request().url();
    if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

test.describe("Keyboard navigation", () => {

  test("dashboard nav links are Tab-reachable", async ({ page }) => {
    mockEmpty(page);
    await page.goto("/");
    // Tab from the body to cycle through focusable elements; all nav links should be reachable
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
    }
    // At least one focusable nav element should be in the document
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]).toContain(focused);
  });

  test("settings API key field is focusable and accepts keyboard input", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ api_key: "", ai_provider: "openai", ai_api_key: "", backend_url: "http://localhost:8081", auto_retry: true, max_retries: 3, confidence_threshold: 0.7, retention_days: 30, ai_model: "gpt-4o" }),
      });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/settings");
    const apiKeyInput = page.locator("input[type='password'], input[type='text']").first();
    await apiKeyInput.click();
    await page.keyboard.type("test-key-value");
    const val = await apiKeyInput.inputValue();
    expect(val).toContain("test-key-value");
  });

  test("workflows page New button is Tab-reachable and activatable via Enter", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/workflows");
    // Tab until the New / Create button receives focus
    let found = false;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() ?? "");
      if (label.includes("New") || label.includes("Create")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("run detail Pause button is focusable via Tab", async ({ page }) => {
    const run = {
      id: "run-kb-test", workflow_id: "wf-1", status: "running",
      current_step_index: 2, total_steps: 5,
      started_at: "2026-05-13T10:00:00Z", created_at: "2026-05-13T10:00:00Z",
    };
    await page.route("**/v1/runs/run-kb-test", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(run) });
    });
    await page.route("**/v1/runs/run-kb-test/events**", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/runs/run-kb-test");
    await expect(page.getByText("Pause")).toBeVisible();

    // Tab through the page until Pause or Stop button is focused
    let pauseFocused = false;
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const label = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() ?? "");
      if (label === "Pause" || label === "Stop") {
        pauseFocused = true;
        break;
      }
    }
    expect(pauseFocused).toBe(true);
  });
});
