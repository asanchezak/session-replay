import { test, expect } from "./fixtures";

test("content script survives page refresh", async ({ context, errors }) => {
  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.waitForTimeout(1000);

  await page.reload();
  await page.waitForTimeout(2000);

  await page.click("h1");
  await page.waitForTimeout(500);

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await page.close();
});

test("content script captures events during recording via popup", async ({ context, extensionId, errors }) => {
  const testPage = await context.newPage();
  await testPage.goto("https://example.com");
  await testPage.waitForTimeout(1000);

  // Start recording via popup
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await popup.waitForTimeout(1000);
  await popup.click("text=Record Workflow");
  await popup.waitForTimeout(500);
  // GoalInputView appears — skip goal entry to start recording immediately
  await popup.click("text=Skip");
  await popup.waitForTimeout(500);

  // Click on test page — content script captures
  await testPage.click("h1");
  await testPage.waitForTimeout(500);
  await testPage.click("p");
  await testPage.waitForTimeout(500);

  // Stop recording
  await popup.bringToFront();
  await popup.waitForTimeout(300);
  await popup.click("text=Stop Recording");
  await popup.waitForTimeout(3000);

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await testPage.close();
  await popup.close();
});

test("content script reinjects after SPA-style navigation", async ({ context, errors }) => {
  const page = await context.newPage();

  await page.goto("https://example.com");
  await page.waitForTimeout(1000);
  await page.click("h1");

  await page.goto("https://example.org");
  await page.waitForTimeout(2000);
  await page.click("h1");

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await page.close();
});
