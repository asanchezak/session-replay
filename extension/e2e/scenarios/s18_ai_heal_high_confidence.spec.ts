/** S18 — AI heal with confidence 0.92 → applied. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S18 — high-confidence AI heal is applied", async ({ page }) => {
  await openTestPage(page, "mangled-css.html");
  // Requires a running backend + a heal override (see existing
  // tests/runs/testing/inject-heal-override). Skipped until that wiring
  // is reproduced for the new test pages.
  expect(true).toBe(true);
});
