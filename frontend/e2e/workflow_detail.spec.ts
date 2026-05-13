/** S41 — Workflow detail Run button triggers a run and opens the Run viewer. */
import { test, expect } from "@playwright/test";

test("S41 — Run button creates a run", async ({ page }) => {
  await page.route("**/v1/workflows/wf-1", async (route) =>
    route.fulfill({
      status: 200, body: JSON.stringify({
        id: "wf-1", name: "Demo", status: "active", version: 1, created_at: new Date().toISOString(),
        steps: [{ step_index: 0, action_type: "click", intent: "x", selector_chain: [{ type: "css", value: "#a" }] }],
      }),
    }),
  );
  await page.route("**/v1/workflows/wf-1/run", async (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ id: "run-1", status: "running", total_steps: 1 }) }),
  );

  await page.goto("/workflows/wf-1");
  await page.getByRole("button", { name: /run/i }).click();
  // Without a Run viewer, the page should at least confirm via a banner/toast that the run started.
  test.fail(true, "F-C-05: no Run viewer / no UI confirmation of run start.");
});
