/**
 * Human-like page navigation primitives for the Playwright daemon.
 *
 * Unlike the extension (which needs chrome.debugger/CDP for trusted clicks),
 * Playwright's page.mouse.move/click/wheel already dispatch through the browser
 * input pipeline (isTrusted:true), so the daemon gets bezier-path trusted
 * clicks for free. The single most important anti-bot change lives here:
 * clickSectionLink CLICKS the in-page "Show all <section>" anchor (curved mouse
 * travel) instead of deep-linking to /details/<section>/ — which is what a real
 * recruiter does and what we previously failed to do.
 *
 * Exposed as a factory so the per-page cursor state is encapsulated and the
 * helpers are unit-testable against fixture pages (the daemon runs a top-level
 * poll loop on import and can't be imported into a test).
 */
import { bezierPath, LINKEDIN_DETAIL_SECTIONS } from "./stealth-core.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPageNav() {
  // Last-known cursor position per page, so successive moves/clicks travel by a
  // bezier curve from where the cursor "is" rather than teleporting.
  const cursorByPage = new WeakMap();

  async function moveMouseAlongBezier(page, to, rand) {
    let cursor = cursorByPage.get(page);
    if (!cursor) {
      cursor = { x: 600 + (rand() - 0.5) * 300, y: 360 + (rand() - 0.5) * 200 };
    }
    const steps = 3 + Math.floor(rand() * 4); // 3-6 moves
    const path = bezierPath(cursor, to, steps, rand);
    for (const p of path) {
      try { await page.mouse.move(p.x, p.y); } catch { /* ignore */ }
      await sleep(30 + Math.floor(rand() * 60));
    }
    cursorByPage.set(page, to);
  }

  // Locate a "Show all <section>" anchor, scroll it into view, return its
  // on-screen center. null if absent.
  async function locateSectionAnchor(page, sectionPath) {
    try {
      return await page.evaluate(async (path) => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const anchors = Array.from(document.querySelectorAll(`a[href*="${path}"]`));
        const noSlash = path.replace(/\/$/, "");
        const target = anchors.find((a) => {
          // Prefer the raw attribute (robust on any origin); fall back to the
          // resolved pathname.
          const raw = a.getAttribute("href") || "";
          if (raw.endsWith(path) || raw.endsWith(noSlash)) return true;
          try {
            const u = new URL(a.href);
            return u.pathname.endsWith(path) || u.pathname.endsWith(noSlash);
          } catch { return false; }
        });
        if (!target) return null;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        await wait(600);
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, sectionPath);
    } catch {
      return null;
    }
  }

  // Click the in-page "Show all" anchor like a human. Returns false (caller
  // falls back to page.goto) if the anchor can't be located.
  async function clickSectionLink(page, sectionPath, rand) {
    const target = await locateSectionAnchor(page, sectionPath);
    if (!target) return false;
    await moveMouseAlongBezier(page, target, rand);
    await sleep(80 + Math.floor(rand() * 140));
    try { await page.mouse.click(target.x, target.y); } catch { return false; }
    return true;
  }

  // Seeded, bidirectional human-like scrolling. `ticks` chosen by the caller
  // (small, varied) rather than a constant.
  async function humanScrollSeeded(page, ticks, rand) {
    for (let i = 0; i < ticks; i++) {
      const dy = (rand() > 0.3 ? 1 : -1) * (300 + Math.floor(rand() * 500));
      try { await page.mouse.wheel(0, dy); } catch { /* ignore */ }
      await sleep(800 + Math.floor(rand() * 1700));
    }
  }

  // Which /details/<section>/ pages have a "Show all" anchor on the current
  // profile. Real readers click into sections that exist; sections without an
  // anchor have inline content (the daemon still goto's them as a fallback to
  // preserve full extraction).
  async function getShowAllSections(page, profileBase) {
    try {
      const slug = (profileBase.match(/\/in\/([^/]+)/) || [])[1];
      if (!slug) return new Set();
      const sectionPaths = LINKEDIN_DETAIL_SECTIONS.map((s) => `/in/${slug}/details/${s}/`);
      const found = await page.evaluate((paths) => {
        const out = [];
        for (const p of paths) {
          if (document.querySelectorAll(`a[href*="${p}"]`).length > 0) out.push(p);
        }
        return out;
      }, sectionPaths);
      return new Set(found);
    } catch {
      return new Set();
    }
  }

  return { moveMouseAlongBezier, locateSectionAnchor, clickSectionLink, humanScrollSeeded, getShowAllSections };
}
