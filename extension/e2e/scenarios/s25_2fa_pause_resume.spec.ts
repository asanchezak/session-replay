/** S25 — 2FA prompt → pause; resume after user enters code. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S25 — 2FA pauses then resumes", async ({ page }) => {
  await openTestPage(page, "2fa-mock.html");
  expect(true).toBe(true);
});
