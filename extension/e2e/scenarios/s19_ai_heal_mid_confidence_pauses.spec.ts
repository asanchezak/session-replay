/** S19 — AI heal at confidence 0.40 must NOT be applied (BUG E-C-07). */
import { test, expect } from "./_helpers";

test("S19 — mid-confidence heal pauses the run", async () => {
  // TODO E-C-07: extension threshold is hard-coded 0.3 and ignores
  // settings.ai_confidence_threshold. Once the threshold gate is in place,
  // this test should run the full heal flow and assert waiting_for_user.
  test.fixme(true, "E-C-07: threshold gate not yet implemented");
});
