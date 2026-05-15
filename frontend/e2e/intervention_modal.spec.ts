import { test, expect } from "@playwright/test";

const WAITING_RUN = {
  id: "run-stuck-1", workflow_id: "wf-broken", status: "waiting_for_user",
  current_step_index: 3, total_steps: 7, pause_reason: "Element not found",
  created_at: new Date().toISOString(),
};

function triggerModal(page: any) {
  return page.route("**/v1/runs*", async (route: any) => {
    const url = route.request().url();
    if (url.includes("status=waiting_for_user")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([WAITING_RUN]) });
    } else {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
  });
}

test.describe("Intervention Modal", () => {

  test("appears when backend reports a waiting_for_user run", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.goto("/");
    await expect(page.getByText("Workflow Paused — Action Required")).toBeVisible({ timeout: 10000 });
  });

  test("shows correct run info: step number, reason, and run ID", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.goto("/");
    const modal = page.getByRole("dialog", { name: /paused/i });
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Step 4")).toBeVisible();
    await expect(page.getByText("Element not found").first()).toBeVisible();
    await expect(page.getByText("#run-stuc")).toBeVisible();
  });

  test("Continue Workflow button sends resume request", async ({ page }) => {
    let resumeCalled = false;
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.route("**/v1/runs/run-stuck-1/resume", async (route: any) => {
      resumeCalled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "run-stuck-1", status: "running" }) });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Continue Workflow" }).click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    expect(resumeCalled).toBe(true);
  });

  test("Cancel Run button requires confirmation then sends cancel request", async ({ page }) => {
    let cancelCalled = false;
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.route("**/v1/runs/run-stuck-1/cancel", async (route: any) => {
      cancelCalled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "run-stuck-1", status: "canceled" }) });
    });
    await page.goto("/");
    // First click — should show "Confirm Cancel"
    await page.getByRole("button", { name: "Cancel Run" }).click({ timeout: 10000 });
    await expect(page.getByText("Confirm Cancel")).toBeVisible();
    // Second click — executes the cancel
    await page.getByRole("button", { name: "Confirm Cancel" }).click();
    await page.waitForTimeout(1000);
    expect(cancelCalled).toBe(true);
  });

  test("shows error message when resume API call fails", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.route("**/v1/runs/run-stuck-1/resume", async (route: any) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Continue Workflow" }).click({ timeout: 10000 });
    await expect(page.getByText("Internal server error")).toBeVisible({ timeout: 3000 });
  });

  test("shows error message when cancel API call fails", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.route("**/v1/runs/run-stuck-1/cancel", async (route: any) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }),
      });
    });
    await page.goto("/");
    // First click — Confirm Cancel
    await page.getByRole("button", { name: "Cancel Run" }).click({ timeout: 10000 });
    // Second click — execute cancel (fails)
    await page.getByRole("button", { name: "Confirm Cancel" }).click();
    await expect(page.getByText("Internal server error")).toBeVisible({ timeout: 3000 });
  });

  test("Review Details button navigates to run detail page", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Review Details" }).click({ timeout: 10000 });
    await expect(page).toHaveURL(/\/runs\/run-stuck-1/);
  });

  test("dashboard status indicator changes to amber when waiting runs exist", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await triggerModal(page);
    await page.goto("/");
    await expect(page.getByText("Needs Attention")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Workflow Paused — Action Required")).toBeVisible();
  });

  test("modal dismisses and dashboard recovers after successful cancel", async ({ page }) => {
    let cancelled = false;
    await page.route("**/v1/workflows*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    // Return a waiting run until cancelled; after cancel the poll returns []
    await page.route("**/v1/runs*", async (route: any) => {
      const url = route.request().url();
      if (url.includes("status=waiting_for_user")) {
        const body = cancelled ? "[]" : JSON.stringify([WAITING_RUN]);
        await route.fulfill({ status: 200, contentType: "application/json", body });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    // Cancel endpoint — set flag so subsequent polls return empty
    await page.route("**/v1/runs/run-stuck-1/cancel", async (route: any) => {
      cancelled = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "run-stuck-1", status: "canceled" }) });
    });
    await page.goto("/");
    // Modal should appear from the poll
    await expect(page.getByText("Workflow Paused — Action Required")).toBeVisible({ timeout: 15000 });
    // Cancel the run via the modal
    await page.getByRole("button", { name: "Cancel Run" }).click();
    await page.getByRole("button", { name: "Confirm Cancel" }).click();
    await page.waitForTimeout(500);
    // Modal should be gone because onResolved() dismisses it
    await expect(page.getByText("Workflow Paused — Action Required")).not.toBeVisible({ timeout: 3000 });
  });
});
