/** S14 — Replay against a custom element with shadow DOM. */
import { test, expect, openTestPage } from "./_helpers";

test.fixme("S14 — shadow-DOM target is clickable through replay", async ({ page }) => {
  await openTestPage(page, "shadow-dom.html");

  // The button lives inside an open shadow root. `document.querySelector`
  // does NOT traverse shadow boundaries, so vanilla replay can't reach it.
  // Once shadow-DOM piercing lands in replay.ts, this becomes green.
  const clicked = await page.evaluate(() => {
    const host = document.querySelector("my-button") as HTMLElement & { shadowRoot?: ShadowRoot };
    const sr = host?.shadowRoot;
    if (!sr) return "no shadow";
    const inner = sr.querySelector("#inner") as HTMLButtonElement;
    inner.click();
    return document.getElementById("clicked")!.textContent;
  });
  expect(clicked).toBe("yes");
});
