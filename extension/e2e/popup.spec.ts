import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

test("popup renders idle state with all UI elements", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(1500);

  await expect(page.getByText("Session Replay")).toBeVisible();
  await expect(page.getByText("Record Workflow")).toBeVisible();
  await expect(page.getByText("Run Workflow")).toBeVisible();
  await expect(page.getByText("Connected")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("clicking record transitions to recording state with visual confirmation", async ({ context, extensionId, errors }) => {
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();

  await popup.clickRecord();
  await popup.page.waitForTimeout(1000);

  await expect(popup.page.getByText("Recording...").first()).toBeVisible();
  await expect(popup.page.getByText("Stop Recording")).toBeVisible();
  await expect(popup.page.getByText("Recording... 0 steps")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await popup.page.close();
});

test("clicking stop returns to idle state", async ({ context, extensionId, errors }) => {
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();

  await popup.clickRecord();
  await popup.page.waitForTimeout(500);
  await expect(popup.page.getByText("Recording...").first()).toBeVisible();

  await popup.clickStop();
  await popup.page.waitForTimeout(2000);

  await expect(popup.page.getByText("Record Workflow")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await popup.page.close();
});

test("service worker responds to START_RECORDING via popup", async ({ context, extensionId, errors }) => {
  // Verify by opening popup — the real user flow
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(1000);
  await expect(page.getByText("Record Workflow")).toBeVisible();

  await page.click("text=Record Workflow");
  await page.waitForTimeout(500);
  // GoalInputView appears; click Skip to start recording
  const skipBtn = page.getByText("Skip");
  if (await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
    await page.waitForTimeout(500);
  }
  await expect(page.getByText("Recording...").first()).toBeVisible();

  await page.click("text=Stop Recording");
  await page.waitForTimeout(2000);
  await expect(page.getByText("Record Workflow")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
