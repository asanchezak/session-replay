/** S11 — Replay after sibling reorder — text fallback wins. */
import { test, expect, openTestPage } from "./_helpers";

test("S11 — text selector resolves when nth-of-type would have failed", async ({ page }) => {
  await openTestPage(page, "stable.html");

  // Reorder list items at runtime.
  await page.evaluate(() => {
    const ul = document.querySelector("#results")!;
    const items = Array.from(ul.children);
    ul.innerHTML = "";
    items.reverse().forEach((i) => ul.appendChild(i));
  });

  const targetFound = await page.evaluate(() => {
    const text = "Second";
    return !!Array.from(document.querySelectorAll("li")).find(
      (li) => (li.textContent || "").trim() === text,
    );
  });
  expect(targetFound).toBe(true);
});
