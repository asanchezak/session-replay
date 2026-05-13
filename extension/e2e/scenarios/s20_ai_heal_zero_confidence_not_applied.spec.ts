/** S20 — confidence 0.0 from the (buggy) OpenAI provider must not silently apply. */
import { test } from "./_helpers";

test("S20 — confidence 0.0 must never apply", async () => {
  test.fail(true, "B-N-05 + E-C-07: OpenAI provider hardcodes 0.0; healer accepts anything > 0.3.");
});
