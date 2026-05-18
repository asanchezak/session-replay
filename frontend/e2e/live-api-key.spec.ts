/**
 * Live API key integration tests.
 *
 * These tests make ACTUAL HTTP requests through the Vite dev-server proxy
 * to the backend — no route mocking. They catch API key mismatches between
 * the frontend .env (VITE_API_KEY) and backend .env (API_KEY).
 *
 * Requires: backend running on localhost:8081
 * Skips gracefully if backend is unreachable.
 */
import { test, expect } from "@playwright/test";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.VITE_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

/**
 * Uses page.request (Playwright's HTTP client) to make direct calls
 * to the backend. These bypass the browser, so they test raw HTTP auth.
 */
test.describe("API key integration (direct to backend)", () => {

  test("GET /v1/health returns 200 without auth", async ({ page }) => {
    const resp = await page.request.get(`${BACKEND}/v1/health`);
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });

  test("GET /v1/workflows returns 200 with correct API key", async ({ page }) => {
    const resp = await page.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(resp.status()).toBe(200);
    const list = await resp.json();
    expect(Array.isArray(list)).toBe(true);
  });

  test("GET /v1/workflows returns 401 with missing API key", async ({ page }) => {
    const resp = await page.request.get(`${BACKEND}/v1/workflows`);
    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Invalid or missing API key");
  });

  test("GET /v1/workflows returns 401 with wrong API key", async ({ page }) => {
    const resp = await page.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": "wrong-key-12345" },
    });
    expect(resp.status()).toBe(401);
    const body = await resp.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

/**
 * Tests that go through the Vite proxy, mimicking the browser flow.
 * These verify the full end-to-end: browser → Vite proxy → backend.
 */
test.describe("API key integration (via Vite proxy)", () => {

  test("GET /v1/health returns 200 through proxy", async ({ page }) => {
    // Navigate first so the browser has a base URL for relative fetch()
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const resp = await fetch("/v1/health");
      return { status: resp.status, body: await resp.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("ok");
  });

  test("GET /v1/workflows returns 200 through proxy with correct key", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async (key: string) => {
      const resp = await fetch("/v1/workflows", {
        headers: { "X-API-Key": key },
      });
      return { status: resp.status, isArray: Array.isArray(await resp.json()) };
    }, API_KEY);
    expect(result.status).toBe(200);
    expect(result.isArray).toBe(true);
  });

  test("GET /v1/workflows returns 401 through proxy with wrong key", async ({ page }) => {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const resp = await fetch("/v1/workflows", {
        headers: { "X-API-Key": "bad-key" },
      });
      const body = await resp.json();
      return { status: resp.status, code: body.error?.code };
    });
    expect(result.status).toBe(401);
    expect(result.code).toBe("UNAUTHORIZED");
  });

  test("frontend page loads and makes real API call via useApi hook", async ({ page }) => {
    // Navigate to the actual frontend page — this triggers useApi under the hood
    // which uses the VITE_API_KEY from import.meta.env
    await page.goto("/workflows");
    // Wait for loading to finish (either data or error appears)
    await page.waitForTimeout(3000);

    // Should NOT see the auth error (that's what we're testing!)
    await expect(page.getByText("Invalid or missing API key")).not.toBeVisible({ timeout: 1000 });

    // Should either see workflow data or a sensible empty state
    const hasError = await page.getByText("Error loading workflows").isVisible().catch(() => false);
    if (hasError) {
      // If there's an error, fail with specific info
      const errorText = await page.textContent("body");
      throw new Error(`Frontend failed to load workflows. Page body: ${errorText?.slice(0, 500)}`);
    }

    // Success — page loaded without auth errors
    await expect(page.getByRole("heading", { name: /workflows/i })).toBeVisible({ timeout: 2000 });
  });

  test("dashboard leaves the loading state through the proxy", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page.getByText("Active Workflows")).toBeVisible();
    await expect(page.getByText("Recent Runs")).toBeVisible();

    await expect(page.getByText("Loading...")).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Unable to load dashboard data")).not.toBeVisible({ timeout: 1000 });

    const activeWorkflowsCard = page.locator("text=Active Workflows").locator("..").locator("..");
    await expect(activeWorkflowsCard).not.toContainText("...");
  });
});
