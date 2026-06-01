// Pure DOM-text extraction cores, lifted verbatim from the page.evaluate closures
// in driver-daemon.mjs (de-dup Phase 2). Each runs against the global `document`
// (a browser page via Playwright `page.evaluate`, or jsdom in unit tests) and is
// SELF-CONTAINED — no module-scope references, no imports, no closures over outer
// state. That invariant is REQUIRED: Playwright serializes the function via
// .toString() to run it in the page, so any external reference would break it.
// Do not add imports or hoist shared helpers here.

// Experience: pick the <ul> with the most list text, return per-<li> paragraphs.
export function experienceParasCore() {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const main = document.querySelector("main") || document.body;
  const candidates = Array.from(main.querySelectorAll("ul")).filter((ul) => !ul.closest("nav") && ul.getAttribute("role") !== "tablist");
  let best = null, score = 0;
  candidates.forEach((ul) => {
    const lis = Array.from(ul.children).filter((c) => c.tagName === "LI");
    if (!lis.length) return;
    const total = lis.reduce((a, li) => a + (li.textContent || "").length, 0);
    if (total > score) { score = total; best = ul; }
  });
  if (!best) return [];
  return Array.from(best.children).filter((c) => c.tagName === "LI").map((li) => {
    const paras = Array.from(li.querySelectorAll("p, h3, h4, div")).filter((e) => e.children.length === 0).map((e) => clean(e.textContent)).filter((t) => t.length > 0 && t.length < 800);
    const spans = Array.from(li.querySelectorAll("span")).filter((s) => s.children.length === 0).map((s) => clean(s.textContent)).filter(Boolean);
    const desc = spans.find((s) => s.length > 40) || "";
    const seen = new Set();
    const uniq = [];
    for (const p of paras) { if (!seen.has(p)) { seen.add(p); uniq.push(p); } }
    return { paras: uniq, desc };
  });
}

// Section list items: each leaf-text bundle from <li> (no nested <li>), with a
// section/article fallback when there are no list items.
export function sectionListItemsCore() {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const leafTexts = (root) => {
    const nodes = Array.from(root.querySelectorAll("li, h3, h4, p, span, a, div"))
      .filter((el) => el.children.length === 0)
      .map((el) => clean(el.textContent))
      .filter((text) => text && text.length < 400);
    const uniq = [];
    const seen = new Set();
    for (const text of nodes) {
      if (seen.has(text)) continue;
      seen.add(text);
      uniq.push(text);
    }
    return uniq;
  };

  const main = document.querySelector("main") || document.body;
  const items = Array.from(main.querySelectorAll("li"))
    .filter((li) => !li.querySelector("li"))
    .map((li) => ({ texts: leafTexts(li) }))
    .filter((item) => item.texts.length > 0);
  if (items.length) return items;

  const blocks = Array.from(main.querySelectorAll("section, article"))
    .map((block) => ({ texts: leafTexts(block).slice(0, 8) }))
    .filter((item) => item.texts.length > 1);
  return blocks;
}

// Raw section text for AI extraction: main text, trimmed at "Ad Options", empty
// when LinkedIn shows the "nothing here" placeholder, with the section header
// prefix stripped (sec = education|skills|certifications|projects|courses).
export function subpageTextCore(sec) {
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const main = document.querySelector("main") || document.body;
  let text = clean(main.textContent || "");
  const adIdx = text.search(/\bAd Options\b/i);
  if (adIdx > 0) text = text.slice(0, adIdx);
  if (/Nothing to see for now|Nothing here yet|a[uú]n no/i.test(text)) return "";
  const STRIP = {
    education: /^(Education|Educaci[oó]n|Formaci[oó]n)\s*/i,
    skills: /^(Skills|Habilidades|Aptitudes)\s*(?:All\s*Industry Knowledge\s*Tools & Technologies\s*Interpersonal Skills\s*(?:Languages\s*)?Other Skills\s*)?/i,
    certifications: /^(Licenses\s*&\s*certifications|Licencias y certificaciones)\s*/i,
    projects: /^(Projects|Proyectos)\s*/i,
    courses: /^(Courses|Cursos)\s*/i,
  };
  if (STRIP[sec]) text = text.replace(STRIP[sec], "");
  return text.trim();
}
