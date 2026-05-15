/**
 * UI tests: frontend auth error handling.
 *
 * Catches runtime scenarios where the API key is wrong or missing
 * — verifies the UI shows a clear error instead of silently failing.
 */
import { test, expect } from "@playwright/test";

const API_KEY = process.env.VITE_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test.describe("Auth error UI", () => {

  test("workflows page shows error when API returns 401", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" },
        }),
      });
    });

    await page.goto("/workflows");
    await expect(page.getByText("Error loading workflows")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Invalid or missing API key")).toBeVisible();
  });

  test("workflows page shows error when API returns 403", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "FORBIDDEN", message: "Origin not allowed" },
        }),
      });
    });

    await page.goto("/workflows");
    await expect(page.getByText("Error loading workflows")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Origin not allowed")).toBeVisible();
  });

  test("runs page shows error when API returns 401", async ({ page }) => {
    await page.route("**/v1/runs*", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" },
        }),
      });
    });

    await page.goto("/runs");
    await expect(page.getByText("Error loading runs")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Invalid or missing API key")).toBeVisible();
  });

  test("workflows page loads data successfully with correct auth", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "wf-1", name: "Test Workflow", status: "active", version: 1, created_at: new Date().toISOString() },
        ]),
      });
    });

    await page.goto("/workflows");
    await expect(page.getByText("Test Workflow")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Error loading workflows")).not.toBeVisible();
  });

  test("navigates between pages after successful auth", async ({ page }) => {
    await page.route("**/v1/workflows*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "wf-1", name: "Cross-page Workflow", status: "active", version: 1, created_at: new Date().toISOString() },
        ]),
      });
    });

    await page.goto("/workflows");
    await expect(page.getByText("Cross-page Workflow")).toBeVisible({ timeout: 5000 });

    await page.goto("/runs");
    await page.goto("/workflows");
    await expect(page.getByText("Cross-page Workflow")).toBeVisible();
  });

  test("real proxy: /v1/health returns 200 via Vite proxy (no auth needed)", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const resp = await fetch("/v1/health");
      return { status: resp.status, ok: resp.ok };
    });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
  });

  test("real proxy: /v1/workflows returns 401 with wrong key via Vite proxy", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const resp = await fetch("/v1/workflows", {
        headers: { "X-API-Key": "this-is-a-bad-key" },
      });
      const body = await resp.json();
      return { status: resp.status, code: body.error?.code };
    });
    expect(result.status).toBe(401);
    expect(result.code).toBe("UNAUTHORIZED");
  });

  test("real proxy: /v1/workflows returns 200 with correct key via Vite proxy", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async (k: string) => {
      const resp = await fetch("/v1/workflows", {
        headers: { "X-API-Key": k },
      });
      const body = await resp.json();
      return { status: resp.status, isArray: Array.isArray(body) };
    }, API_KEY);
    expect(result.status).toBe(200);
    expect(result.isArray).toBe(true);
  });

});
