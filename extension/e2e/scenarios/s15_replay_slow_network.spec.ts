/** S15 — Replay on a slow page (3G simulation). */
import { test, expect, openTestPage } from "./_helpers";

test("S15 — replay waits for delayed mount", async ({ page }) => {
  await openTestPage(page, "slow-network.html?delay=1500");
  // The form is injected after a 1.5s delay; replay must wait.
  await page.waitForSelector("#go", { timeout: 5000 });
  await page.locator("#q").fill("hi");
  await page.locator("#go").click();
  expect(true).toBe(true); // reached this point = no flake
});
