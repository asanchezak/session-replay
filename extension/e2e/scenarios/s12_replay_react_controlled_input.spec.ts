/** S12 — React controlled input.
 *
 * Expected to fail today (E-C-01): `simulateType` does bare `element.value = …`
 * which React ignores. The test checks the React state mirror updates.
 */
import { test, expect, openTestPage } from "./_helpers";

test("S12 — React controlled input updates state on replay", async ({ page }) => {
  await openTestPage(page, "react-controlled-input.html");

  // Simulate the replay path explicitly: set value + dispatch input/change.
  await page.evaluate(() => {
    const input = document.querySelector("#q") as HTMLInputElement;
    input.focus();
    input.value = "Hello React";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  });

  const mirrored = await page.locator("#state-mirror").textContent({ timeout: 2000 });
  test.fail(
    (mirrored || "") !== "Hello React",
    "BUG E-C-01: React did not see the value change because bare element.value= bypasses its setter shim",
  );
});
