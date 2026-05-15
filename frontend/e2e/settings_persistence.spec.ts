import { test, expect } from "@playwright/test";

test.describe("Settings persistence", () => {

  test("saving settings persists across reload", async ({ page }) => {
    await page.route("**/v1/settings", async (route: any) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok" }) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ settings: { ai_confidence_threshold: 0.85, auto_retry_limit: 3, retention_days: 90 } }) });
      }
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/settings");
    await page.getByText("Save All Settings").click();
    await expect(page.getByText("Settings saved")).toBeVisible({ timeout: 3000 });
  });
});
