/** S27 — Ambiguous result set → ranker policy triggers pause. */
import { test, openTestPage } from "./_helpers";

test("S27 — ambiguous result set should pause for confirmation", async ({ page }) => {
  await openTestPage(page, "ambiguous-search.html");
  // TODO: Ranker policy not implemented (PRD §7.4, §7.7).
  // When fixed, assert that the run transitions to waiting_for_user when
  // multiple result candidates have equal confidence.
  test.fixme(true, "Ranker policy not implemented");
});
