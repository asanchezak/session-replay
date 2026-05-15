import { test, expect } from "@playwright/test";

const RUNS_MOCK = [
  { id: "run-001", workflow_id: "wf-1", status: "completed", current_step_index: 7, total_steps: 7, created_at: "2026-05-12T18:30:00Z" },
  { id: "run-002", workflow_id: "wf-1", status: "running", current_step_index: 3, total_steps: 7, created_at: "2026-05-13T10:15:00Z" },
  { id: "run-003", workflow_id: "wf-2", status: "failed", current_step_index: 2, total_steps: 5, error_summary: "Element not found", created_at: "2026-05-13T08:00:00Z" },
  { id: "run-004", workflow_id: "wf-3", status: "waiting_for_user", current_step_index: 4, total_steps: 6, pause_reason: "CAPTCHA detected", created_at: "2026-05-13T12:00:00Z" },
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

test.describe("Runs page", () => {

  test("shows loading state while fetching", async ({ page }) => {
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/runs");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state when no runs exist", async ({ page }) => {
    await mockRuns(page, []);
    await page.goto("/runs");
    await expect(page.getByText("No runs yet")).toBeVisible();
    await expect(page.getByText("Start a workflow to see execution history here.")).toBeVisible();
    await expect(page.getByText("Browse Workflows")).toBeVisible();
  });

  test("shows error state when API fails", async ({ page }) => {
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Internal server error" } }) });
    });
    await page.goto("/runs");
    await expect(page.getByText("Error loading runs")).toBeVisible();
    await expect(page.getByText("Internal server error")).toBeVisible();
  });

  test("renders runs table with all columns", async ({ page }) => {
    await mockRuns(page, RUNS_MOCK);
    await page.goto("/runs");
    await expect(page.locator("td").filter({ hasText: "#run-001" }).first()).toBeVisible();
    await expect(page.getByText("3/7")).toBeVisible();
    await expect(page.getByText("Element not found")).toBeVisible();
  });

  test("renders correct status badges for each run status", async ({ page }) => {
    await mockRuns(page, RUNS_MOCK);
    await page.goto("/runs");
    // StatusBadge renders lowercase status text
    await expect(page.getByText("completed")).toBeVisible();
    await expect(page.getByText("running")).toBeVisible();
    await expect(page.getByText("failed")).toBeVisible();
    await expect(page.getByText("Waiting")).toBeVisible();
  });

  test("shows dash for runs without errors", async ({ page }) => {
    await mockRuns(page, [RUNS_MOCK[0]]);
    await page.goto("/runs");
    await expect(page.locator("td").filter({ hasText: "—" }).first()).toBeVisible();
  });
});
