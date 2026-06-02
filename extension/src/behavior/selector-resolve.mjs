/**
 * Generic selector-chain resolution for the Playwright daemon — the runtime
 * twin of the extension's `src/content/{replay,selectors}.ts` resolver.
 *
 * WHY a separate port and not an import: the extension resolver is pure DOM
 * (`document.*`) and the daemon runs in Node/Playwright, so it cannot import it.
 * Rather than reimplement each of the 6 selector strategies with Playwright
 * Locator APIs — whose semantics differ (e.g. `getByText` does NOT reproduce the
 * viewport-priority / interactive-first ordering, and there is no native
 * anchor-by-offset) — we inject the VERBATIM pure-DOM resolver into the page via
 * `page.evaluateHandle` and get back an `ElementHandle`. That gives byte-for-byte
 * parity with the extension and a handle we can scrollIntoView / boundingBox /
 * focus / click. Proven against a fixture for all 6 strategy types.
 *
 * `resolveChainInPage` MUST stay self-contained (no module-scope refs / imports)
 * because Playwright serializes it via `Function.prototype.toString` to run it in
 * the page. It is also directly callable in jsdom unit tests (it only touches
 * `document`/`window`/`CSS`/`XPathResult`), so the resolution logic is testable
 * without a browser; the geometry-dependent strategies (text viewport-priority,
 * anchor hit-test) are covered by the Playwright e2e fixture spec.
 *
 * Anti-bot: this module does NOT own the human-input primitives. `clickResolved`
 * / `typeResolved` receive the daemon's OWN `moveMouseAlongBezier` (single shared
 * cursor) + `typeHumanLike` as injected deps, so timing/behavior stays
 * byte-for-byte identical to the rest of the daemon.
 */

import { orderSelectorChain } from "./step-interpreter.mjs";

/** Phase A interactive verbs the dispatcher resolves from `selector_chain`. */
export const PHASE_A_VERBS = new Set(["click", "type"]);

/**
 * Sort a selector_chain by descending score — re-exported from the shared
 * step-interpreter (single source of truth). The in-page resolver below sorts
 * identically inside (it can't import — it's serialized into the page — so a
 * conformance test guards it against drift).
 */
export const orderChain = orderSelectorChain;

/**
 * Self-contained port of `findElementBySelectors` + its 6 strategy helpers from
 * src/content/replay.ts (lines 176-504). Runs in-page (evaluateHandle) and in
 * jsdom. Returns the matched Element, or null. DO NOT reference module scope.
 */
export function resolveChainInPage(chain) {
  function _deepQuerySelector(selector, root = document) {
    try { const direct = root.querySelector(selector); if (direct) return direct; } catch { /* invalid */ }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      const sr = node.shadowRoot;
      if (sr) { const found = _deepQuerySelector(selector, sr); if (found) return found; }
    }
    return null;
  }
  function _deepQuerySelectorAll(selector, root = document) {
    const out = [];
    try { out.push(...Array.from(root.querySelectorAll(selector))); } catch { /* invalid */ }
    const all = root.querySelectorAll("*");
    for (const node of all) { const sr = node.shadowRoot; if (sr) out.push(..._deepQuerySelectorAll(selector, sr)); }
    return out;
  }
  function normalizeText(value) {
    return (value || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[\n\t]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function interactiveCandidates() {
    const selector = "button, a, [role='button'], [role='link'], input[type='button'], input[type='submit'], [aria-label]";
    return _deepQuerySelectorAll(selector);
  }
  function findElementByShadowCss(raw) {
    let parsed; try { parsed = JSON.parse(raw); } catch { return null; }
    const hostChain = Array.isArray(parsed.host_chain) ? parsed.host_chain : [];
    const target = String(parsed.target || ""); if (!target) return null;
    let root = document;
    for (const hostSel of hostChain) {
      if (!root) return null;
      let host = null; try { host = root.querySelector(hostSel); } catch { /* invalid */ }
      if (!host) host = _deepQuerySelector(hostSel, root);
      if (!host) return null;
      const sr = host.shadowRoot; root = sr ? sr : host;
    }
    if (!root) return null;
    try { const direct = root.querySelector(target); if (direct) return direct; } catch { /* invalid */ }
    return _deepQuerySelector(target, root);
  }
  function findElementByText(text) {
    const needle = normalizeText(text);
    const vw = window.innerWidth, vh = window.innerHeight;
    const inViewport = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh;
    };
    const matches = (el) => normalizeText(el.textContent || "") === needle;
    const includes = (el) => normalizeText(el.textContent || "").includes(needle);
    const interactive = interactiveCandidates();
    const all = _deepQuerySelectorAll("a, button, span, label, div, h1, h2, h3, h4, h5, h6, p, li, td, th");
    for (const subset of [interactive, all]) {
      const inView = subset.filter(inViewport);
      const offScreen = subset.filter((el) => !inViewport(el));
      for (const pool of [inView, offScreen]) {
        const exactHit = pool.find(matches); if (exactHit) return exactHit;
        const includesHit = pool.find(includes); if (includesHit) return includesHit;
      }
    }
    return null;
  }
  function findElementByAccessibility(data) {
    let role = "", label = "";
    try {
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) { role = String(parsed[0] || ""); label = String(parsed[1] || ""); }
      else if (parsed && typeof parsed === "object") { role = String(parsed.role || ""); label = String(parsed.label || parsed.name || ""); }
    } catch {
      const bracket = data.match(/^([a-zA-Z]+)\s*\[\s*text\s*=\s*['"](.+?)['"]\s*\]$/);
      if (bracket) { role = bracket[1] || ""; label = bracket[2] || ""; }
      else if (data.includes("|")) { const p = data.split("|"); role = p[0] || ""; label = p[1] || ""; }
      else {
        const rw = data.match(/^(button|link|textbox|combobox|menuitem|tab)\s+(.+)$/i);
        if (rw) { role = rw[1] || ""; label = rw[2] || ""; } else { label = data; }
      }
    }
    const nl = normalizeText(label);
    if (nl) {
      const els = interactiveCandidates();
      const exactA11y = els.find((el) => normalizeText(el.getAttribute("aria-label") || "") === nl); if (exactA11y) return exactA11y;
      const exactText = els.find((el) => normalizeText(el.textContent || "") === nl); if (exactText) return exactText;
      const incA11y = els.find((el) => normalizeText(el.getAttribute("aria-label") || "").includes(nl)); if (incA11y) return incA11y;
      const incText = els.find((el) => normalizeText(el.textContent || "").includes(nl)); if (incText) return incText;
      const byText = findElementByText(label); if (byText) return byText;
    }
    if (role) {
      const nr = role.trim().toLowerCase();
      const roleMatches = _deepQuerySelectorAll(`[role="${CSS.escape(nr)}"]`);
      if (roleMatches.length > 0) {
        if (nl) {
          const rle = roleMatches.find((el) => normalizeText(el.textContent || "") === nl); if (rle) return rle;
          const rli = roleMatches.find((el) => normalizeText(el.textContent || "").includes(nl)); if (rli) return rli;
        }
        return roleMatches[0];
      }
    }
    return null;
  }
  function findElementByXPath(xpath) {
    const DANGEROUS = /count\(|string-length\(|substring\(|name\(|translate\(|normalize-space\(/i;
    if (DANGEROUS.test(xpath)) return null;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue;
  }
  function findElementByAnchor(value) {
    try {
      const parsed = JSON.parse(value);
      const anchorEl = document.querySelector(parsed.anchor_selector); if (!anchorEl) return null;
      const r = anchorEl.getBoundingClientRect();
      const tx = r.left + (parsed.offset_x || 0), ty = r.top + (parsed.offset_y || 0);
      const candidate = document.elementFromPoint(tx + 1, ty + 1);
      if (candidate && candidate !== document.body && candidate !== document.documentElement) return candidate;
      if (parsed.relation === "inside") return anchorEl.querySelector("*:first-child");
      return null;
    } catch { return null; }
  }
  function findElementBySelectors(c) {
    const sorted = [...(Array.isArray(c) ? c : [])].sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const sel of sorted) {
      try {
        let element = null;
        switch (sel.type) {
          case "shadow_css": element = findElementByShadowCss(sel.value); break;
          case "css": element = document.querySelector(sel.value) || _deepQuerySelector(sel.value); break;
          case "text": element = findElementByText(sel.value); break;
          case "accessibility": element = findElementByAccessibility(sel.value); break;
          case "xpath": element = findElementByXPath(sel.value); break;
          case "anchor": element = findElementByAnchor(sel.value); break;
        }
        if (element) return element;
      } catch { continue; }
    }
    return null;
  }
  return findElementBySelectors(chain);
}

/**
 * Resolve a selector_chain to a usable ElementHandle in the live page.
 * Returns `{ kind: "handle", handle }` for a VISIBLE, scrolled-into-view element,
 * or `null` (no match / invalid chain / not visible) so callers fall through to
 * the next `methods[]` selector — mirroring replay.ts's element-failure path.
 */
export async function resolveLocator(page, selectorChain, opts = {}) {
  if (!Array.isArray(selectorChain) || selectorChain.length === 0) return null;
  let handle;
  try {
    handle = await page.evaluateHandle(resolveChainInPage, selectorChain);
  } catch {
    return null;
  }
  const el = handle.asElement();
  if (!el) { await handle.dispose().catch(() => {}); return null; }
  try {
    await el.scrollIntoViewIfNeeded({ timeout: opts.timeoutMs ?? 3000 });
  } catch { /* anchored/off-screen — visibility + box checks decide below */ }
  const visible = await el.isVisible().catch(() => false);
  if (!visible) { await el.dispose().catch(() => {}); return null; }
  return { kind: "handle", handle: el };
}

/** On-screen center of a resolved target, or null if it has no layout box. */
export async function targetCenter(target) {
  if (!target || !target.handle) return null;
  const box = await target.handle.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Human click on a resolved target: re-scroll into view (coords must be fresh —
 * a scrolled page yields stale/negative boxes), bezier mouse travel, then a
 * trusted `page.mouse.click`. NEVER `handle.click()` (skips the curved travel).
 * `deps.moveMouseAlongBezier` MUST be the daemon's shared-cursor instance.
 */
export async function clickResolved(page, target, deps) {
  const { moveMouseAlongBezier, orand } = deps;
  await target.handle.scrollIntoViewIfNeeded().catch(() => {});
  const c = await targetCenter(target);
  if (!c) return false;
  await moveMouseAlongBezier(page, c, orand);
  await page.mouse.click(c.x, c.y);
  return true;
}

/**
 * Human type into a resolved target: click-to-focus (trusted bezier click, like a
 * person tabbing into a field) then per-character keystrokes via the daemon's
 * `typeHumanLike`. NEVER `page.fill()` (instantaneous value injection).
 */
export async function typeResolved(page, target, value, deps) {
  const { moveMouseAlongBezier, typeHumanLike, orand } = deps;
  const focused = await clickResolved(page, target, { moveMouseAlongBezier, orand });
  if (!focused) { await target.handle.focus().catch(() => {}); }
  await typeHumanLike(page, value, orand);
  return true;
}
