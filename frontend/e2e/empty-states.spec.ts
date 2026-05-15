import { test, expect } from "@playwright/test";

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

test.describe("Empty states across pages", () => {

  test("workflows empty state", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/workflows");
    await expect(page.getByText("No workflows yet")).toBeVisible();
  });

  test("runs empty state", async ({ page }) => {
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/runs");
    await expect(page.getByText("No runs yet")).toBeVisible();
  });

  test("audit empty state before run selected", async ({ page }) => {
    await page.route("**/v1/runs*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/audit");
    await expect(page.getByText("No audit events")).toBeVisible();
  });

  test("connectors empty state", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("No connectors configured")).toBeVisible();
  });

  test("dashboard shows 'No runs yet' when no runs exist", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto("/");
    await expect(page.getByText("No runs yet.")).toBeVisible();
  });

  test("run detail shows empty events state", async ({ page }) => {
    await page.route("**/v1/runs/empty-run", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "empty-run", workflow_id: "wf-1", status: "completed", current_step_index: 5, total_steps: 5, created_at: new Date().toISOString() }) });
    });
    // Trailing ** matches requests with ?limit=500 query param
    await page.route("**/v1/runs/empty-run/events**", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/runs/empty-run");
    // Events tab is not the default; must switch to it first
    await page.getByRole("button", { name: /^events/i }).click();
    await expect(page.getByText("No events yet")).toBeVisible();
  });
});
