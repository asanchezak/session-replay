import { test, expect } from "@playwright/test";

test.describe("AppShell layout", () => {

  test("sidebar renders all 6 navigation items", async ({ page }) => {
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    // Use role-based selectors to avoid breadcrumb duplicates
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Workflows" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Runs" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Connectors" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  });

  test("clicking sidebar items navigates correctly", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Workflows" }).click();
    await expect(page).toHaveURL(/\/workflows/);
    await page.getByRole("link", { name: "Runs" }).click();
    await expect(page).toHaveURL(/\/runs/);
    await page.getByRole("link", { name: "Connectors" }).click();
    await expect(page).toHaveURL(/\/connectors/);
  });

  test("global search shows results for workflows", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "wf-1", name: "Candidate Search", status: "active", version: 1, created_at: new Date().toISOString() }]) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("Candidate");
    await page.waitForTimeout(500);
    await expect(page.getByText("Candidate Search")).toBeVisible();
  });

  test("global search result click navigates to workflow detail", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "wf-1", name: "My Workflow", status: "active", version: 1, created_at: new Date().toISOString() }]) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("My Workflow");
    await page.waitForTimeout(500);
    await page.getByText("My Workflow").click();
    await expect(page).toHaveURL(/\/workflows\/wf-1/);
  });

  test("status indicator shows 'All Systems' when no waiting runs", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await expect(page.getByText("All Systems")).toBeVisible({ timeout: 10000 });
  });
});
