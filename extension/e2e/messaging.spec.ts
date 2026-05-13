import { test, expect } from "./fixtures";

test("popup sends GET_STATE to service worker and receives response", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(1500);
  await expect(page.getByText("Record Workflow")).toBeVisible();
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("extension responds to START_RECORDING via popup", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(1000);

  // Click record — this sends START_RECORDING to SW
  await page.click("text=Record Workflow");
  await page.waitForTimeout(1000);
  await expect(page.getByText("Recording...").first()).toBeVisible();
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("recording events via content script creates workflow", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  // Navigate to real page where content script runs
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  // Record via popup
  const popup = await ext.openPopup();
  await popup.clickRecord();
  await expect(popup.page.getByText("Recording...").first()).toBeVisible();

  // Click on the test page (content script sends RECORD_EVENT)
  await testPage.click("h1");
  await testPage.waitForTimeout(300);
  await testPage.click("p");
  await testPage.waitForTimeout(300);

  // Stop recording via popup
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(300);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);

  // Verify workflow created
  const wfResp = await testPage.request.get("http://localhost:8081/v1/workflows", {
    headers: { "X-API-Key": "dev-api-key-change-in-production" },
  });
  const workflows = await wfResp.json() as any[];
  const hasNewWorkflow = workflows.some((w: any) => w.status === "draft");
  expect(hasNewWorkflow).toBeTruthy();

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await popup.page.close();
  await testPage.close();
});

test("STOP_RECORDING via popup returns to idle state", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(1000);

  await page.click("text=Record Workflow");
  await page.waitForTimeout(500);
  await expect(page.getByText("Recording...").first()).toBeVisible();

  await page.click("text=Stop Recording");
  await page.waitForTimeout(2000);
  await expect(page.getByText("Record Workflow")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
