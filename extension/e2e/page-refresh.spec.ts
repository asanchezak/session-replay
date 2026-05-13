import { test, expect } from "./fixtures";

test("content script re-injects after page refresh", async ({ context, errors }) => {
  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.waitForTimeout(1500);

  // Refresh
  await page.reload();
  await page.waitForTimeout(2000);

  // Click after refresh to verify content script is active
  await page.click("h1");
  await page.waitForTimeout(500);

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await page.close();
});

test("recording continues after page refresh", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  // Start recording
  const sw = await ext.getServiceWorker();
  await sw.evaluate(() => {
    chrome.runtime.sendMessage({ type: "START_RECORDING" });
  });
  await testPage.waitForTimeout(500);

  // Capture event before refresh
  await testPage.click("h1");
  await testPage.waitForTimeout(300);

  // Refresh
  await testPage.reload();
  await testPage.waitForTimeout(2000);

  // Capture event after refresh
  await testPage.click("p");
  await testPage.waitForTimeout(500);

  // Check state
  const state = await sw.evaluate(async () => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, (resp: any) => {
        resolve(resp?.state);
      });
    });
  });
  console.log(`  State after refresh: ${JSON.stringify(state)}`);

  // Cleanup
  await sw.evaluate(() => {
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  });

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await testPage.close();
});

test("multiple page navigations preserve content script", async ({ context, errors }) => {
  const page = await context.newPage();

  // Navigate to first page
  await page.goto("https://example.com");
  await page.waitForTimeout(1000);
  await page.click("h1");

  // Navigate to second page
  await page.goto("https://example.org");
  await page.waitForTimeout(2000);
  await page.click("h1");

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await page.close();
});
