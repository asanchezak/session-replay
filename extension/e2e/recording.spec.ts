import { test, expect } from "./fixtures";
import { PopupPage, DashboardPage } from "./page-objects";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("full human-like recording flow: open page → record → interact → stop → verify workflow",
  async ({ context, extensionId, errors }) => {

  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const recordingStartedAt = Date.now();

  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await expect(testPage.locator("body")).toBeVisible();
  await testPage.waitForTimeout(1500);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();
  // Wait for content script to process SET_RECORDING before interacting
  await testPage.bringToFront();
  await testPage.waitForTimeout(800);
  await testPage.screenshot({ path: "test-results/recording-01-record-started.png" });

  await testPage.click("h1");
  await testPage.waitForTimeout(300);
  await testPage.click("p");
  await testPage.waitForTimeout(300);
  await testPage.locator("a").click();
  await testPage.waitForTimeout(500);

  await popup.page.bringToFront();
  await popup.page.waitForTimeout(500);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);

  expect(await popup.isIdle()).toBeTruthy();
  await testPage.screenshot({ path: "test-results/recording-02-stopped.png" });

  const wfResp = await testPage.request.get(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY },
  });
  const workflows = await wfResp.json() as any[];
  const latestWf = [...workflows]
    .filter((w: any) => new Date(w.created_at).getTime() >= recordingStartedAt)
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    ?? workflows[0];
  expect(["draft", "active"]).toContain(latestWf.status);

  const detailResp = await testPage.request.get(`${BACKEND}/v1/workflows/${latestWf.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const detail = await detailResp.json() as any;
  expect(detail.steps.length).toBeGreaterThanOrEqual(1);
  const firstStepWithSelector = detail.steps.find((s: any) => Array.isArray(s.selector_chain) && s.selector_chain.length > 0);
  if (firstStepWithSelector) {
    expect(firstStepWithSelector.selector_chain[0].value).toBeTruthy();
  } else {
    expect(detail.steps.some((s: any) => s.action_type === "navigate" && s.value)).toBe(true);
  }
  await testPage.screenshot({ path: "test-results/recording-03-workflow-verified.png" });

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);

  await popup.page.close();
  await testPage.close();
});

test("recorded workflow appears in dashboard list", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  await testPage.click("h1");
  await testPage.waitForTimeout(300);
  await testPage.click("p");

  await popup.page.bringToFront();
  await popup.clickStop();
  await popup.page.waitForTimeout(2000);

  const dashPage = await context.newPage();
  const dashboard = new DashboardPage(dashPage);
  await dashboard.gotoWorkflows();
  await dashPage.waitForTimeout(2000);

  await expect(dashPage.getByText("No recorded workflows yet")).toHaveCount(0);
  await expect(dashPage.locator("table tbody tr").first()).toBeVisible();
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);

  await popup.page.close();
  await testPage.close();
  await dashPage.close();
});

test("recording from popup shows step count incrementing", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();

  await testPage.click("h1");
  await testPage.waitForTimeout(500);
  await testPage.click("p");
  await testPage.waitForTimeout(500);

  await popup.page.close();
  const popup2 = await ext.openPopup();
  await popup2.page.waitForTimeout(1500);

  const count = await popup2.getStepCount();
  expect(count).toBeGreaterThanOrEqual(1);

  await popup2.clickStop();
  await popup2.page.waitForTimeout(2000);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await testPage.close();
  await popup2.page.close();
});
