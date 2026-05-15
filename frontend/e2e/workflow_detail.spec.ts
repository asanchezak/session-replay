import { test, expect } from "@playwright/test";

const WORKFLOW = {
  id: "wf-1", name: "Candidate Search", description: "Search for candidates", status: "active", version: 3, prompt: "Find senior React devs",
  steps: [
    { step_index: 0, action_type: "navigate", selector_chain: [{ type: "css", value: "body" }], value: "https://linkedin.com/jobs" },
    { step_index: 1, action_type: "click", selector_chain: [{ type: "css", value: "#candidates-tab" }] },
    { step_index: 2, action_type: "extract", selector_chain: [{ type: "xpath", value: "//table" }] },
  ],
};

test.describe("Workflow Detail page", () => {

  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async () => { await new Promise(() => {}); });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Loading workflow...")).toBeVisible();
  });

  test("shows error state when workflow not found", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "Workflow not found" } }) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Back").first()).toBeVisible();
  });

  test("renders workflow name, description, status, version", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    // Use heading for the name to avoid breadcrumb duplicate
    await expect(page.getByRole("heading", { name: "Candidate Search" })).toBeVisible();
    await expect(page.getByText("Search for candidates")).toBeVisible();
    await expect(page.getByText("active").first()).toBeVisible();
    await expect(page.getByText("Version 3")).toBeVisible();
  });

  test("renders steps card with numbered list", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("0.")).toBeVisible();
    await expect(page.getByText("1.")).toBeVisible();
    await expect(page.getByText("2.")).toBeVisible();
    await expect(page.getByText("navigate")).toBeVisible();
    await expect(page.getByText("click")).toBeVisible();
    await expect(page.getByText("extract")).toBeVisible();
  });

  test("shows intent/prompt when available", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await expect(page.getByText("Intent / Prompt")).toBeVisible();
    await expect(page.getByText("Find senior React devs")).toBeVisible();
  });

  test("Run button sends POST and changes to Starting", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    // Component sets running=true synchronously before postMessage; button changes to "Starting..."
    await expect(page.getByRole("button", { name: "Starting..." })).toBeVisible();
  });

  test("back button navigates to /workflows", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user") || url.includes("limit=100")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
        return;
      }
      await new Promise(() => {});
    });
    await page.goto("/workflows/wf-1");
    await page.getByText("Back").click();
    await expect(page).toHaveURL(/\/workflows$/);
  });
});
