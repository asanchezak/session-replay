/** S40 — Dashboard refreshes KPIs and surfaces failed runs. */
import { test, expect } from "@playwright/test";

test("S40 — dashboard renders KPIs from the backend", async ({ page }) => {
  await page.route("**/v1/workflows*", async (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([{
      id: "w1", name: "Demo", status: "active", version: 1, created_at: new Date().toISOString(),
    }]) }),
  );
  await page.route("**/v1/runs*", async (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([
      { id: "r1", workflow_id: "w1", status: "completed", current_step_index: 5, total_steps: 5, created_at: new Date().toISOString() },
      { id: "r2", workflow_id: "w1", status: "failed", current_step_index: 2, total_steps: 5, error_summary: "boom", created_at: new Date().toISOString() },
    ]) }),
  );

  await page.goto("/");
  await expect(page.getByText(/Demo/)).toBeVisible({ timeout: 5000 });
});

test.fixme("S40 — failed-run banner expands beyond 2 items", async () => {
  // Pinned in unit (frontend/src/__tests__/pages/Dashboard.test.tsx).
});
