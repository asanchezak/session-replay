/** S20 — confidence 0.0 from the (buggy) OpenAI provider must not silently apply. */
import { test } from "./_helpers";

test("S20 — confidence 0.0 must never apply", async () => {
  // TODO B-N-05 + E-C-07: OpenAI provider hardcodes 0.0; healer accepts
  // anything > 0.3 threshold. Once both are fixed, this test should run
  // the heal flow and assert the heal is NOT applied.
  test.fixme(true, "B-N-05 + E-C-07: confidence threshold not enforced");
});
