import { test, expect } from "@playwright/test";

const WORKFLOWS = [
  { id: "wf-1", name: "Demo Workflow", status: "active", version: 1, created_at: "2026-05-01T10:00:00Z" },
  { id: "wf-2", name: "Another Workflow", status: "active", version: 2, created_at: "2026-05-02T10:00:00Z" },
];
const RUNS = [
  { id: "run-1", workflow_id: "wf-1", status: "completed", current_step_index: 5, total_steps: 5, created_at: "2026-05-12T18:30:00Z", started_at: "2026-05-12T18:00:00Z" },
  { id: "run-2", workflow_id: "wf-1", status: "running", current_step_index: 3, total_steps: 7, created_at: "2026-05-13T10:15:00Z" },
  { id: "run-3", workflow_id: "wf-2", status: "failed", current_step_index: 2, total_steps: 5, error_summary: "Timeout", created_at: "2026-05-13T08:00:00Z" },
  { id: "run-4", workflow_id: "wf-3", status: "waiting_for_user", current_step_index: 4, total_steps: 6, pause_reason: "CAPTCHA", created_at: "2026-05-13T12:00:00Z" },
];

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

test.describe("Dashboard", () => {

  test("renders KPIs from backend data", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await mockRuns(page, RUNS);
    await page.goto("/");
    await expect(page.getByText("Active Workflows")).toBeVisible();
    await expect(page.getByText("Success Rate")).toBeVisible();
    await expect(page.getByText("Waiting for You")).toBeVisible();
    await expect(page.getByText("Failed Runs")).toBeVisible();
  });

  test("shows attention banner when runs need user action", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await mockRuns(page, RUNS);
    await page.goto("/");
    // Dashboard renders "Requires Attention" as a text label
    await expect(page.getByText("Requires Attention")).toBeVisible({ timeout: 5000 });
  });

  test("recent run rows navigate to run detail on click", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await mockRuns(page, RUNS);
    await page.goto("/");
    await page.getByText("Run #run-2").click();
    await expect(page).toHaveURL(/\/runs\/run-2$/);
  });

  test("shows 3 workflow template cards", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await mockRuns(page, RUNS);
    await page.goto("/");
    await expect(page.getByText("Search & Extract")).toBeVisible();
    await expect(page.getByText("Fill & Submit")).toBeVisible();
    await expect(page.getByText("Open & Inspect")).toBeVisible();
  });

  test("shows 'View all N more failed runs' when >10 failures", async ({ page }) => {
    const failedRuns = Array.from({ length: 12 }, (_, i) => ({
      id: `run-f${i}`, workflow_id: "wf-1", status: "failed", current_step_index: 1, total_steps: 3, error_summary: "Error", created_at: new Date().toISOString(),
    }));
    const otherRuns = [
      { id: "run-ok", workflow_id: "wf-1", status: "completed", current_step_index: 3, total_steps: 3, created_at: new Date().toISOString() },
    ];
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await mockRuns(page, [...otherRuns, ...failedRuns]);
    await page.goto("/");
    await expect(page.getByText(/View all.*more failed runs/)).toBeVisible();
  });

  test("shows 'No runs yet' when dashboard has no data", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRuns(page, []);
    await page.goto("/");
    await expect(page.getByText("No runs yet.")).toBeVisible();
  });

  test("status indicator shows 'Needs Attention' when waiting runs exist and modal appears", async ({ page }) => {
    const waitingRun = { id: "run-wait", workflow_id: "wf-1", status: "waiting_for_user", current_step_index: 2, total_steps: 5, pause_reason: "Selector mismatch", created_at: new Date().toISOString() };
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([waitingRun]) });
        return;
      }
      if (url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([waitingRun]) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RUNS) });
    });
    await page.goto("/");
    // Top bar status indicator should reflect the waiting run
    await expect(page.getByText("Needs Attention")).toBeVisible({ timeout: 10000 });
    // Modal should also appear
    await expect(page.getByText("Workflow Paused — Action Required")).toBeVisible();
  });
});
