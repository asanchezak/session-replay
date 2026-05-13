import { test, expect } from "./fixtures";
import { PopupPage, DashboardPage } from "./page-objects";

const BACKEND = "http://localhost:8081";

test("full human-like recording flow: open page → record → interact → stop → verify workflow",
  async ({ context, extensionId, errors }) => {

  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await expect(testPage.locator("body")).toBeVisible();
  await testPage.waitForTimeout(1500);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();
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
    headers: { "X-API-Key": "dev-api-key-change-in-production" },
  });
  const workflows = await wfResp.json() as any[];
  const latestWf = workflows[0];
  expect(latestWf.status).toBe("draft");

  const detailResp = await testPage.request.get(`${BACKEND}/v1/workflows/${latestWf.id}`, {
    headers: { "X-API-Key": "dev-api-key-change-in-production" },
  });
  const detail = await detailResp.json() as any;
  expect(detail.steps.length).toBeGreaterThanOrEqual(2);
  expect(detail.steps[0].selector_chain).not.toBeNull();
  expect(detail.steps[0].selector_chain[0].value).toBeTruthy();
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

  await expect(dashPage.getByText("Draft").first()).toBeVisible();
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
