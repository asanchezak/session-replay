import { test, expect } from "@playwright/test";

const SETTINGS_RESPONSE = {
  settings: { ai_confidence_threshold: 0.85, auto_retry_limit: 3, retention_days: 90 },
};

function mockRunsSilent(page: any) {
  return page.route("**/v1/runs*", async (route: any) => {
    const url = route.request().url();
    if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    } else {
      await new Promise(() => {});
    }
  });
}

test.describe("Settings page", () => {

  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/settings*", async () => { await new Promise(() => {}); });
    await mockRunsSilent(page);
    await page.goto("/settings");
    await expect(page.getByText("Loading settings…")).toBeVisible();
  });

  test("loads and displays all setting categories", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    await expect(page.getByText("AI Confidence Threshold")).toBeVisible();
    await expect(page.getByText("Auto-Retry Limit")).toBeVisible();
    await expect(page.getByText("Log Retention Period")).toBeVisible();
    await expect(page.getByText("Extension API Key")).toBeVisible();
  });

  test("AI confidence slider adjusts value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    const slider = page.locator('input[type="range"]');
    await expect(page.getByText("85%")).toBeVisible();
    await slider.fill("60");
    await expect(page.getByText("60%")).toBeVisible();
  });

  test("auto-retry dropdown changes value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    const selects = page.locator("select");
    await selects.nth(0).selectOption("5");
    await expect(selects.nth(0)).toHaveValue("5");
  });

  test("retention dropdown changes value", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    const selects = page.locator("select");
    await selects.nth(1).selectOption("30");
    await expect(selects.nth(1)).toHaveValue("30");
  });

  test("API key show/hide toggle works", async ({ page }) => {
    await page.route("**/v1/settings*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    await expect(page.getByText("Show")).toBeVisible();
    await page.getByText("Show").click();
    await expect(page.getByText("Hide")).toBeVisible();
  });

  test("save button sends PUT and shows success banner", async ({ page }) => {
    let savedBody: any = null;
    await page.route("**/v1/settings*", async (route: any) => {
      if (route.request().method() === "PUT") {
        savedBody = JSON.parse(route.request().postData() || "{}");
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
      }
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Settings saved")).toBeVisible({ timeout: 3000 });
    expect(savedBody).not.toBeNull();
    expect(savedBody.auto_retry_limit).toBe(3);
  });

  test("save error shows error banner", async ({ page }) => {
    await page.route("**/v1/settings", async (route: any) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Save failed" } }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SETTINGS_RESPONSE) });
      }
    });
    await mockRunsSilent(page);
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Failed to save settings")).toBeVisible({ timeout: 3000 });
  });
});
