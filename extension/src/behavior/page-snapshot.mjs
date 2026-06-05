/**
 * Reusable page snapshotter for the Recruiter (/talent) flows.
 *
 * Goal (per project rule feedback_recruiter_offline_selector_iteration): capture
 * each page ONCE during a live run so selectors can be iterated OFFLINE against the
 * saved HTML — never reloading the very-sensitive LinkedIn account to debug.
 *
 * Per stage it writes, into `dir`:
 *   - <stage>.html      full document HTML, with OPEN shadow roots inlined as
 *                       <template shadowrootmode="open"> (declarative shadow DOM),
 *                       so the snapshot re-parses with its shadow trees intact and
 *                       can be loaded via file:// in `analyze-snapshot.mjs`.
 *   - <stage>.dom.json  inventory of interactive elements (incl. inside shadow
 *                       roots) with the attributes we build selectors from.
 *   - <stage>.png       viewport screenshot (best-effort).
 *   - manifest.json     index: stage -> { files, url, title, counts, ts }.
 *
 * Pure helper (no top-level side effects) so the daemon and the standalone
 * recruiter-*.mjs scripts can both import it.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── In-page: serialize the document to HTML, inlining open shadow roots. ──────
// Declarative shadow DOM keeps overlays/composers (LinkedIn uses open shadow
// roots) analyzable offline. Closed roots are unreachable by design — skipped.
const SERIALIZE_FN = () => {
  const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  function serialize(node) {
    if (node.nodeType === Node.TEXT_NODE) return esc(node.nodeValue);
    if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.nodeValue}-->`;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName.toLowerCase();
    let attrs = "";
    for (const a of Array.from(node.attributes || [])) attrs += ` ${a.name}="${escAttr(a.value)}"`;
    if (VOID.has(tag)) return `<${tag}${attrs}>`;
    let inner = "";
    // Open shadow root first, as a declarative template.
    if (node.shadowRoot) {
      let sh = "";
      for (const c of Array.from(node.shadowRoot.childNodes)) sh += serialize(c);
      inner += `<template shadowrootmode="open">${sh}</template>`;
    }
    // <template> content lives in .content, not childNodes.
    if (tag === "template" && node.content) {
      for (const c of Array.from(node.content.childNodes)) inner += serialize(c);
    } else {
      for (const c of Array.from(node.childNodes)) inner += serialize(c);
    }
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }
  const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>\n` : "";
  return dt + serialize(document.documentElement);
};

// ── In-page: inventory of interactive elements, piercing open shadow roots. ───
const INVENTORY_FN = () => {
  const SEL = 'button, a[href], a[role="button"], input, textarea, select, [contenteditable], [role="textbox"], [role="combobox"], [role="link"], [role="dialog"], [data-view-name]';
  const out = [];
  function collect(root, shadowPath) {
    let els;
    try { els = Array.from(root.querySelectorAll(SEL)); } catch { els = []; }
    for (const el of els) {
      let cs; try { cs = window.getComputedStyle(el); } catch { cs = {}; }
      out.push({
        tag: el.tagName ? el.tagName.toLowerCase() : "",
        role: el.getAttribute && el.getAttribute("role") || "",
        aria: (el.getAttribute && el.getAttribute("aria-label") || "").trim(),
        placeholder: el.getAttribute && (el.getAttribute("placeholder") || el.getAttribute("aria-placeholder")) || "",
        name: el.getAttribute && el.getAttribute("name") || "",
        type: el.getAttribute && el.getAttribute("type") || "",
        href: el.getAttribute && el.getAttribute("href") || "",
        id: el.id || "",
        cls: (el.className && el.className.toString ? el.className.toString() : "").slice(0, 200),
        dataView: el.getAttribute && (el.getAttribute("data-view-name") || el.getAttribute("data-live-test-component")) || "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 90),
        inShadow: shadowPath || "",
        visible: el.offsetParent !== null && cs.visibility !== "hidden" && cs.display !== "none",
      });
      if (el.shadowRoot) collect(el.shadowRoot, (shadowPath ? shadowPath + " >> " : "") + (el.tagName ? el.tagName.toLowerCase() : "") + (el.id ? "#" + el.id : ""));
    }
  }
  collect(document, "");
  return { count: out.length, elements: out };
};

function readManifest(dir) {
  const p = resolve(dir, "manifest.json");
  if (existsSync(p)) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* fall through */ } }
  return { stages: [], created: new Date().toISOString() };
}

/**
 * Snapshot the current page state into `dir` under `stage`.
 * @returns {Promise<object>} the manifest entry for this stage.
 */
export async function snapshotPage(page, { dir, stage, screenshot = true } = {}) {
  mkdirSync(dir, { recursive: true });
  const entry = { stage, ts: new Date().toISOString(), files: {} };
  try { entry.url = page.url(); } catch { entry.url = ""; }
  try { entry.title = await page.title(); } catch { entry.title = ""; }

  try {
    const html = await page.evaluate(SERIALIZE_FN);
    writeFileSync(resolve(dir, `${stage}.html`), html);
    entry.files.html = `${stage}.html`;
    entry.htmlBytes = Buffer.byteLength(html);
  } catch (e) { entry.htmlError = String(e && e.message || e); }

  try {
    const inv = await page.evaluate(INVENTORY_FN);
    inv.url = entry.url; inv.title = entry.title;
    writeFileSync(resolve(dir, `${stage}.dom.json`), JSON.stringify(inv, null, 2));
    entry.files.dom = `${stage}.dom.json`;
    entry.elementCount = inv.count;
  } catch (e) { entry.domError = String(e && e.message || e); }

  if (screenshot) {
    try { await page.screenshot({ path: resolve(dir, `${stage}.png`), fullPage: false }); entry.files.png = `${stage}.png`; }
    catch (e) { entry.pngError = String(e && e.message || e); }
  }

  const man = readManifest(dir);
  man.stages = man.stages.filter((s) => s.stage !== stage);
  man.stages.push(entry);
  man.updated = new Date().toISOString();
  writeFileSync(resolve(dir, "manifest.json"), JSON.stringify(man, null, 2));
  return entry;
}

export { SERIALIZE_FN, INVENTORY_FN };
