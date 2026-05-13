/** S27 — Ambiguous result set → ranker policy triggers pause. */
import { test, openTestPage } from "./_helpers";

test("S27 — ambiguous result set should pause for confirmation", async ({ page }) => {
  await openTestPage(page, "ambiguous-search.html");
  test.fail(true, "Ranker policy not implemented (PRD §7.4, §7.7).");
});
