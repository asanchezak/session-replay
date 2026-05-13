/** S16 — Replay step opens a popup tab; orchestrator must follow it. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S16 — popup tab is followed", async ({ page, context }) => {
  await openTestPage(page, "popup-tab.html");
  const newPagePromise = context.waitForEvent("page", { timeout: 5000 });
  await page.locator("#open").click();
  const newPage = await newPagePromise;
  expect(newPage.url()).toMatch(/stable\.html$/);
});
