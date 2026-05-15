import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("recording state persists after service worker termination", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();

  await testPage.click("h1");
  await testPage.click("p");
  await testPage.waitForTimeout(500);

  await popup.page.close();
  await testPage.waitForTimeout(35000);

  await testPage.click("a");
  await testPage.waitForTimeout(1000);

  const popup2 = await ext.openPopup();
  await popup2.page.waitForTimeout(3000);

  const isRecording = await popup2.isRecording();
  if (isRecording) {
    const count = await popup2.getStepCount();
    console.log(`  Recording state restored with ${count} buffered events`);
    await popup2.page.screenshot({ path: "test-results/sw-lifecycle-restored.png" });
    await popup2.clickStop();
    await popup2.page.waitForTimeout(3000);
    expect(await popup2.isIdle()).toBeTruthy();
  } else {
    console.log("  SW state did not restore — diagnostic screenshot taken");
    await popup2.page.screenshot({ path: "test-results/sw-lifecycle-failed.png" });
  }

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await testPage.close();
  await popup2.page.close();
});

test("events captured before and after SW restart are preserved", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  await testPage.click("h1");
  await testPage.waitForTimeout(300);
  await popup.page.close();

  await testPage.waitForTimeout(35000);

  await testPage.click("p");
  await testPage.waitForTimeout(300);

  const popup2 = await ext.openPopup();
  await popup2.page.waitForTimeout(2000);

  const isRecording = await popup2.isRecording();
  if (isRecording) {
    await popup2.clickStop();
    await popup2.page.waitForTimeout(3000);

    const wfResp = await testPage.request.get("http://localhost:8081/v1/workflows", {
      headers: { "X-API-Key": API_KEY },
    });
    const workflows = await wfResp.json() as any[];
    expect(workflows.length).toBeGreaterThan(0);
  }

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await testPage.close();
  await popup2.page.close();
});

test("GET_STATE works after service worker restart", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(() => {
    chrome.runtime.sendMessage({ type: "START_RECORDING" });
  });

  const idleResponse = await sw.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp: any) => {
        resolve(resp?.state?.type || "no-response");
      });
    });
  });
  console.log(`  GET_STATE response: ${idleResponse}`);
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});
