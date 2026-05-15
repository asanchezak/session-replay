import { test, expect } from "@playwright/test";

const WORKFLOWS_MOCK = [
  { id: "wf-1", name: "Candidate Search", status: "active", version: 3, description: "Search LinkedIn", created_at: "2026-05-01T10:00:00Z" },
  { id: "wf-2", name: "Job Sync", status: "active", version: 1, created_at: "2026-05-05T14:00:00Z" },
  { id: "wf-3", name: "Profile Review", status: "draft", version: 1, created_at: "2026-05-10T09:00:00Z" },
];

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

test.describe("Workflows page", () => {

  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/workflows*", async () => { await new Promise(() => {}); });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state when no workflows exist", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("No workflows yet")).toBeVisible();
    await expect(page.getByText("Install Extension")).toBeVisible();
    await expect(page.getByText("Use Template")).toBeVisible();
  });

  test("shows error state when API fails", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }) });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("Error loading workflows")).toBeVisible();
    await expect(page.getByText("Invalid or missing API key")).toBeVisible();
  });

  test("renders workflow table with name, status, version, and created date", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("Candidate Search")).toBeVisible();
    await expect(page.getByText("Job Sync")).toBeVisible();
    await expect(page.getByText("v3")).toBeVisible();
    await expect(page.getByText("draft")).toBeVisible();
    await expect(page.getByText("active").first()).toBeVisible();
  });

  test("clicking a workflow row navigates to detail page", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "wf-1", name: "Candidate Search", status: "active", version: 3, steps: [] }) });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await page.getByText("Candidate Search").click();
    await expect(page.getByRole("heading", { name: "Candidate Search" })).toBeVisible();
  });

  test("renders StatusBadge correctly for each workflow status", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("draft")).toBeVisible();
    await expect(page.getByText("active").first()).toBeVisible();
  });

  test("New button is present on the page", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOWS_MOCK) });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByRole("button", { name: /new/i })).toBeVisible();
  });
});
