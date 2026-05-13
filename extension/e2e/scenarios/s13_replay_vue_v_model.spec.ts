/** S13 — Vue v-model. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S13 — Vue v-model updates on replay", async ({ page }) => {
  await openTestPage(page, "vue-vmodel.html");

  await page.evaluate(() => {
    const input = document.querySelector("#q") as HTMLInputElement;
    input.value = "Hello Vue";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const mirrored = await page.locator("#state-mirror").textContent();
  expect(mirrored).toBe("Hello Vue");
});
