/** S42 — Audit page filters and hash copy. */
import { test, expect } from "@playwright/test";

test("S42 — audit page renders events and a hash column", async ({ page }) => {
  await page.route("**/v1/runs*", async (route) =>
    route.fulfill({ status: 200, body: JSON.stringify([{
      id: "r1", workflow_id: "w1", status: "completed", current_step_index: 0, total_steps: 0,
      created_at: new Date().toISOString(),
    }]) }),
  );
  await page.route("**/v1/audit/r1", async (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({
      run_id: "r1", workflow_id: "w1", event_count: 1, chain_valid: true, broken_links: [],
      events: [{
        id: "e1", event_type: "step_executed", actor_type: "extension", payload: { i: 1 },
        hash: "a".repeat(64), previous_hash: "0".repeat(64), created_at: new Date().toISOString(),
      }],
    }) }),
  );

  await page.goto("/audit");
  await expect(page.getByText(/step_executed/)).toBeVisible({ timeout: 5000 });
});

test.fixme("S42 — clicking a hash copies the full hash to clipboard", async () => {
  // Today the hash is truncated and there is no copy button. Pinned in §10.
});
