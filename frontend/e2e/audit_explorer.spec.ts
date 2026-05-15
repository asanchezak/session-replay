import { test, expect } from "@playwright/test";

const RUNS = [
  { id: "run-1", workflow_id: "wf-1", status: "completed", current_step_index: 7, total_steps: 7, created_at: "2026-05-13T10:00:00Z" },
  { id: "run-2", workflow_id: "wf-1", status: "failed", current_step_index: 3, total_steps: 5, created_at: "2026-05-13T11:00:00Z" },
];

const AUDIT_DATA = {
  run_id: "run-1", workflow_id: "wf-1", event_count: 3, chain_valid: true, broken_links: [],
  events: [
    { id: "evt-1", event_type: "run_started", actor_type: "system", payload: {}, hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", previous_hash: "0000000000000000000000000000000000000000", created_at: "2026-05-13T10:00:01Z" },
    { id: "evt-2", event_type: "step_executed", actor_type: "system", payload: { step_index: 1 }, hash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5", previous_hash: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4", created_at: "2026-05-13T10:00:05Z" },
    { id: "evt-3", event_type: "run_completed", actor_type: "system", payload: {}, hash: "c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6", previous_hash: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5", created_at: "2026-05-13T10:05:00Z" },
  ],
};

function mockRuns(page: any, runs: object[]) {
  return page.route("**/v1/runs*", async (route: any) => {
    const url = route.request().url();
    if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runs) });
  });
}

test.describe("Audit Explorer", () => {

  test("shows empty state with no runs available", async ({ page }) => {
    await mockRuns(page, []);
    await page.goto("/audit");
    await expect(page.getByText("No audit events")).toBeVisible();
    await expect(page.getByText("Run a workflow and select it above")).toBeVisible();
  });

  test("selecting a run loads audit data", async ({ page }) => {
    await mockRuns(page, RUNS);
    await page.route("**/v1/audit/run-1*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    // Audit events appear in table — use table-specific locators
    await expect(page.locator("td").filter({ hasText: "run_started" })).toBeVisible();
    await expect(page.locator("td").filter({ hasText: "step_executed" })).toBeVisible();
    await expect(page.locator("td").filter({ hasText: "run_completed" })).toBeVisible();
  });

  test("shows chain valid banner for intact hash chain", async ({ page }) => {
    await mockRuns(page, RUNS);
    await page.route("**/v1/audit/run-1*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await expect(page.getByText("Hash Chain Valid")).toBeVisible();
    await expect(page.getByText("3 events, 0 broken links")).toBeVisible();
  });

  test("shows chain compromised banner for broken chain", async ({ page }) => {
    const corrupt = { ...AUDIT_DATA, chain_valid: false, broken_links: [{ event_id: "evt-2", index: 1, expected: "xxx", actual: "yyy" }] };
    await mockRuns(page, RUNS);
    await page.route("**/v1/audit/run-1*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(corrupt) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    await expect(page.getByText("Hash Chain COMPROMISED")).toBeVisible();
  });

  test("event type filter filters events", async ({ page }) => {
    await mockRuns(page, RUNS);
    await page.route("**/v1/audit/run-1*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    const filterSelect = page.locator("select").nth(1);
    await filterSelect.selectOption("run_started");
    await page.waitForTimeout(500);
    await expect(page.getByText("1 of 3 events")).toBeVisible();
  });

  test("clicking event row expands full details", async ({ page }) => {
    await mockRuns(page, RUNS);
    await page.route("**/v1/audit/run-1*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AUDIT_DATA) });
    });
    await page.goto("/audit");
    await page.locator("select").first().selectOption("run-1");
    await page.waitForTimeout(1000);
    // Click the step_executed cell in the table row (not the select option)
    await page.locator("td").filter({ hasText: "step_executed" }).click();
    await expect(page.getByText("Full hash:")).toBeVisible();
    await expect(page.getByText("Previous hash:")).toBeVisible();
  });
});
