import { test, expect } from "@playwright/test";

const CONNECTOR_MOCK = { id: "conn-1", name: "Production Odoo", type: "odoo", status: "connected", last_sync: "2 minutes ago" };

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

test.describe("Connectors page", () => {

  test("shows loading state", async ({ page }) => {
    await page.route("**/v1/connectors*", async () => { await new Promise(() => {}); });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("Loading...")).toBeVisible();
  });

  test("shows empty state with add button when no connectors", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("No connectors configured")).toBeVisible();
    await expect(page.getByText("Add Connector").first()).toBeVisible();
  });

  test("shows error banner when API fails", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Backend unreachable" } }) });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("Failed to load connectors")).toBeVisible();
  });

  test("renders connector card with name, type, and status icon", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CONNECTOR_MOCK]) });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("Production Odoo")).toBeVisible();
    await expect(page.getByText("Type: odoo")).toBeVisible();
    await expect(page.getByText("2 minutes ago")).toBeVisible();
  });

  test("shows Test, Configure, and View Logs buttons per connector", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([CONNECTOR_MOCK]) });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await expect(page.getByText("Test").first()).toBeVisible();
    await expect(page.getByText("Configure").first()).toBeVisible();
    await expect(page.getByText("View Logs").first()).toBeVisible();
  });

  test("add connector form toggles visibility", async ({ page }) => {
    await page.route("**/v1/connectors*", async (route: any) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await page.getByText("Add Connector").first().click();
    await expect(page.getByText("New Connector")).toBeVisible();
    await expect(page.getByText("Save")).toBeVisible();
  });

  test("creating a connector sends POST and refetches list", async ({ page }) => {
    let connectors: object[] = [];
    await page.route("**/v1/connectors*", async (route: any) => {
      if (route.request().method() === "POST") {
        connectors = [CONNECTOR_MOCK];
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(CONNECTOR_MOCK) });
      } else {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(connectors) });
      }
    });
    await mockRunsSilent(page);
    await page.goto("/connectors");
    await page.getByText("Add Connector").first().click();
    await page.locator('input[placeholder="Connector name"]').fill("My Connector");
    await page.locator('input[placeholder="https://odoo.example.com"]').fill("https://odoo.example.com");
    await page.locator('input[placeholder="Database"]').fill("qaodoo");
    await page.locator('input[placeholder="Username"]').fill("admin");
    await page.getByText("Save").click();
    await page.waitForTimeout(1000);
    await expect(page.getByText("Production Odoo")).toBeVisible();
  });
});
