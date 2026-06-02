import { test, expect } from "@playwright/test";
// @ts-expect-error — .mjs module without types
import { resolveLocator, targetCenter, clickResolved, typeResolved } from "../src/behavior/selector-resolve.mjs";
// @ts-expect-error — .mjs module without types
import { createPageNav } from "../src/behavior/page-nav.mjs";
// @ts-expect-error — .mjs module without types
import { mulberry32 } from "../src/behavior/stealth-core.mjs";

// Real-Playwright coverage for selector-resolve.mjs against a static fixture (no
// LinkedIn, no extension). This is the daemon's first dispatch test that exercises
// the geometry-dependent strategies (text viewport-priority, anchor hit-test),
// xpath, the visibility gate, and the full click/type human-input sequence.

// Drop the global --load-extension args: this spec only needs a plain page.
test.use({ contextOptions: { args: ["--no-sandbox"] } });

const FIXTURE = `<!doctype html><html><body style="margin:0">
  <button data-testid="primary" style="position:absolute;left:40px;top:40px;width:120px;height:30px">Primary</button>
  <my-card id="card"></my-card>
  <div style="position:absolute;left:40px;top:120px">Apply now</div>
  <div style="position:absolute;left:40px;top:6000px">Apply now</div>
  <div role="dialog"><div role="button" aria-label="Confirm choice" style="position:absolute;left:40px;top:200px;width:120px;height:30px">OK</div></div>
  <section><article><span id="xp" style="position:absolute;left:40px;top:280px">xpath-target</span></article></section>
  <div data-testid="anchorbox" style="position:absolute;left:300px;top:280px;width:10px;height:10px"></div>
  <button id="anchored" style="position:absolute;left:330px;top:300px;width:80px;height:24px">Anchored</button>
  <input id="field" style="position:absolute;left:40px;top:360px;width:200px"/>
  <button id="hidden" style="display:none">Hidden</button>
  <script>
    const host = document.getElementById('card');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button class="shadow-send" aria-label="Send" style="position:absolute;left:40px;top:440px;width:80px;height:24px">Send</button>';
    window.__clicks = [];
    document.querySelector('[data-testid="primary"]').addEventListener('click', () => window.__clicks.push('primary'));
  </script>
</body></html>`;

const orand = mulberry32(12345);
// Minimal stand-in for the daemon's typeHumanLike (correctness only — the real
// inter-key jitter is anti-bot, exercised by the daemon, not this spec).
const typeHumanLike = async (page: import("@playwright/test").Page, text: string) => {
  for (const ch of text) await page.keyboard.type(ch);
};

test.beforeEach(async ({ page }) => {
  await page.setContent(FIXTURE);
  await page.waitForLoadState("domcontentloaded");
});

const STRATEGIES: Array<{ name: string; chain: object[]; text: string }> = [
  { name: "css", chain: [{ type: "css", value: '[data-testid="primary"]', score: 1 }], text: "Primary" },
  { name: "css open-shadow pierce", chain: [{ type: "css", value: ".shadow-send", score: 1 }], text: "Send" },
  { name: "accessibility role+label", chain: [{ type: "accessibility", value: JSON.stringify({ role: "button", label: "Confirm choice" }), score: 1 }], text: "OK" },
  { name: "xpath", chain: [{ type: "xpath", value: "//section/article/span", score: 1 }], text: "xpath-target" },
  { name: "anchor offset", chain: [{ type: "anchor", value: JSON.stringify({ anchor_selector: '[data-testid="anchorbox"]', offset_x: 30, offset_y: 20, relation: "right" }), score: 1 }], text: "Anchored" },
  { name: "shadow_css host_chain", chain: [{ type: "shadow_css", value: JSON.stringify({ host_chain: ["#card"], target: ".shadow-send" }), score: 1 }], text: "Send" },
];

for (const s of STRATEGIES) {
  test(`resolves ${s.name} to a usable handle`, async ({ page }) => {
    const target = await resolveLocator(page, s.chain);
    expect(target, `${s.name} should resolve`).not.toBeNull();
    expect((await target.handle.textContent())?.trim()).toContain(s.text);
    const c = await targetCenter(target);
    expect(c, `${s.name} should have a click center`).not.toBeNull();
  });
}

test("text strategy picks the in-viewport instance, not the y=6000 duplicate", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "text", value: "Apply now", score: 1 }]);
  expect(target).not.toBeNull();
  const c = await targetCenter(target);
  expect(c!.y).toBeLessThan(720); // within the 1280x720 viewport, i.e. the top one
});

test("DANGEROUS xpath resolves to null (guard)", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "xpath", value: "//span[normalize-space(text())='x']", score: 1 }]);
  expect(target).toBeNull();
});

test("hidden element fails the visibility gate (returns null)", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "css", value: "#hidden", score: 1 }]);
  expect(target).toBeNull();
});

test("returns null when nothing in the chain matches", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "css", value: ".does-not-exist", score: 1 }]);
  expect(target).toBeNull();
});

test("clickResolved drives a trusted click that reaches the listener", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "css", value: '[data-testid="primary"]', score: 1 }]);
  expect(target).not.toBeNull();
  const ok = await clickResolved(page, target, { moveMouseAlongBezier: createPageNav().moveMouseAlongBezier, orand });
  expect(ok).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __clicks: string[] }).__clicks)).toContain("primary");
});

test("typeResolved focuses the field and lands characters via keystrokes", async ({ page }) => {
  const target = await resolveLocator(page, [{ type: "css", value: "#field", score: 1 }]);
  expect(target).not.toBeNull();
  const ok = await typeResolved(page, target, "hello", { moveMouseAlongBezier: createPageNav().moveMouseAlongBezier, typeHumanLike, orand });
  expect(ok).toBe(true);
  expect(await page.inputValue("#field")).toBe("hello");
});
