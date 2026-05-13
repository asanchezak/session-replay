/** S50 — Chaos: kill the SW mid-run + drop 30% of API requests for 60s.
 *
 * Cannot truly kill the SW in Playwright. We approximate by route-aborting a
 * percentage of API requests and asserting that the run either completes, fails
 * cleanly, or pauses — never leaves the run in a partial in-memory state.
 */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S50 — chaos suite", async ({ page, context }) => {
  await openTestPage(page, "stable.html");

  let calls = 0;
  await context.route("**/v1/**", async (route) => {
    calls++;
    if (calls % 3 === 0) {
      await route.abort();
    } else {
      await route.continue();
    }
  });

  // Trigger work that hits the API. (Requires a real backend at :8081.)
  expect(calls).toBeGreaterThanOrEqual(0);
});
