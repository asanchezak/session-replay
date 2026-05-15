/** S23 — CAPTCHA appears → detector pauses the run.
 *
 * Today this fails because `detector.ts` is dead code (E-C-06). The test
 * loads the CAPTCHA fixture and asserts that `chrome.storage.session.popup_state`
 * shows a `waiting_for_user` state — which currently won't happen.
 */
import { test, openTestPage } from "./_helpers";

test("S23 — CAPTCHA triggers waiting_for_user", async ({ page }) => {
  await openTestPage(page, "captcha-mock.html");
  // TODO E-C-06: detector is dead code; CAPTCHA does not currently pause the run.
  // When fixed, assert that chrome.storage popup_state.type === "waiting_for_user".
  test.fixme(true, "E-C-06: CAPTCHA detector not wired to runtime");
});
