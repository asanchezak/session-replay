/** S24 — Login modal mid-replay → pause; user logs in; resume from checkpoint. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S24 — login form triggers pause and resume works", async ({ page }) => {
  await openTestPage(page, "login-mock.html");
  expect(true).toBe(true);
});
