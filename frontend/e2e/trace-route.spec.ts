import { test, expect } from "@playwright/test";

test.describe("Trace route", () => {
  test("renders trace page via app router at /runs/:id/trace", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/audit/r1", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              id: "evt-1",
              event_type: "run_started",
              actor_type: "system",
              payload: {},
              hash: "a".repeat(64),
              previous_hash: "0".repeat(64),
              created_at: "2026-05-18T12:00:00Z",
            },
          ],
        }),
      });
    });

    await page.goto("/runs/r1/trace");
    await expect(page.getByText("Audit Trail — Run r1")).toBeVisible();
    await expect(page.getByText("run_started")).toBeVisible();
  });
});
