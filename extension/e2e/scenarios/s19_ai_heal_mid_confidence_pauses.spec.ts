/** S19 — AI heal at confidence 0.40 must NOT be applied (BUG E-C-07). */
import { test, expect } from "./_helpers";

test("S19 — mid-confidence heal pauses the run", async () => {
  // Today: the extension applies any heal with confidence > 0.3. Once the
  // threshold gate is in place, the run pauses for human input instead.
  // This is enforced at the unit level in extension/tests/test_healer.test.ts.
  test.fail(true, "E-C-07: extension threshold is hard-coded 0.3 and ignores settings.ai_confidence_threshold.");
});
