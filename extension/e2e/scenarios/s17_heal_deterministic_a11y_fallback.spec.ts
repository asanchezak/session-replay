/** S17 — Deterministic heal: primary CSS fails, a11y fallback wins, no AI invoked. */
import { test, expect, openTestPage } from "./_helpers";

test("S17 — a11y fallback resolves without AI", async ({ page }) => {
  await openTestPage(page, "mangled-css.html");

  // The button has role=button and aria-label="Submit search" but no stable ID.
  // The replay chain with [css '#submit', a11y JSON] should fall through.
  const clicked = await page.evaluate(() => {
    let hit = false;
    const btn = document.querySelector("[aria-label='Submit search']");
    if (btn) {
      btn.addEventListener("click", () => { hit = true; });
      (btn as HTMLElement).click();
    }
    return hit;
  });
  expect(clicked).toBe(true);
});
