/** S22 — AI returns malformed JSON → audit logs parse error, run pauses. */
import { test, expect } from "./_helpers";

test.fixme("S22 — malformed AI response is handled gracefully", async () => {
  // Backend integration covered in backend/tests/integration/test_ai_provider_failures.py.
  expect(true).toBe(true);
});
