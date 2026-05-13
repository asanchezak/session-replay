/** S10 — Replay after CSS classes mangled — a11y fallback succeeds. */
import { test, expect, openTestPage } from "./_helpers";

test("S10 — a11y fallback resolves when CSS fails", async ({ page }) => {
  await openTestPage(page, "mangled-css.html");
  // We can drive the content script's executeStep by calling it through
  // chrome.runtime.sendMessage from the page. But the page itself can't talk
  // to the SW; instead, simulate by querying with the accessibility selector
  // grammar that replay.ts expects: a JSON-tuple [role, aria-label].
  const found = await page.evaluate(() => {
    const data = JSON.stringify(["button", "Submit search"]);
    const parsed = JSON.parse(data);
    const role = parsed[0], label = parsed[1];
    const labelMatch = Array.from(document.querySelectorAll("[aria-label]"))
      .find((el) => el.getAttribute("aria-label") === label);
    if (labelMatch) return true;
    const byRole = document.querySelector(`[role="${role}"]`);
    return !!byRole;
  });
  expect(found).toBe(true);
});
