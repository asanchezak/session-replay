/**
 * UI-level auth tests for the extension popup.
 *
 * Tests the actual popup UI (not SW evaluate) to catch runtime auth
 * scenarios:
 * - Settings panel shows configured key
 * - Changing the key in settings persists correctly
 * - Workflow list loads when auth is valid
 */
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test.describe("Popup auth UI", () => {

  test("settings panel shows the current API key", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();

    // Seed the key into storage like onInstalled would
    const sw = context.serviceWorkers()[0];
    await sw.evaluate((key: string) => chrome.storage.session.set({ apiKey: key }), API_KEY);

    // Reload popup to pick up the stored key
    await popup.page.reload();
    await popup.page.waitForTimeout(1000);

    // Open settings
    await popup.page.locator('button[title="Settings"]').click();
    await popup.page.waitForTimeout(500);

    // Auth key input should contain the correct value
    const authInput = popup.page.locator('input[placeholder="dev-api-key-change-in-production"]');
    await expect(authInput).toBeVisible();
    const value = await authInput.inputValue();
    expect(value).toBe(API_KEY);

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("changing API key in settings saves to storage", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();

    // Seed initial key
    const sw = context.serviceWorkers()[0];
    await sw.evaluate((key: string) => chrome.storage.session.set({ apiKey: key }), API_KEY);

    // Open settings
    await popup.page.reload();
    await popup.page.waitForTimeout(1000);
    await popup.page.locator('button[title="Settings"]').click();
    await popup.page.waitForTimeout(500);

    // Type a new key
    const authInput = popup.page.locator('input[placeholder="dev-api-key-change-in-production"]');
    await authInput.fill("changed-api-key");

    // Click Save
    await popup.page.getByText("Save").click();
    await popup.page.waitForTimeout(1000);

    // Verify storage was updated
    const stored = await sw.evaluate(() => chrome.storage.session.get("apiKey"));
    expect(stored.apiKey).toBe("changed-api-key");

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("clicking 'Run Workflow' with correct key shows workflow list UI", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();

    // Seed correct API key
    const sw = context.serviceWorkers()[0];
    await sw.evaluate((key: string) => chrome.storage.session.set({ apiKey: key }), API_KEY);

    // Reload and click Run Workflow
    await popup.page.reload();
    await popup.page.waitForTimeout(1000);
    await popup.page.getByText("Run Workflow").click();
    await popup.page.waitForTimeout(2000);

    // Should see either workflow list or empty state — but never an error message
    const hasWorkflows = await popup.page.getByText("Select Workflow").isVisible().catch(() => false);
    const hasEmptyState = await popup.page.getByText("No workflows yet").isVisible().catch(() => false);
    expect(hasWorkflows || hasEmptyState).toBe(true);

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

});
