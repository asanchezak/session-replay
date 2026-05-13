/** S26 — Unexpected confirm modal → pause; user "accept and continue". */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S26 — unexpected modal pauses run", async ({ page }) => {
  await openTestPage(page, "modal-unexpected.html");
  expect(true).toBe(true);
});
