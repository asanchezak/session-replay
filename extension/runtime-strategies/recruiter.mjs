function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function runtimeValue(runtime, key, fallback) {
  return runtime && runtime[key] !== undefined ? runtime[key] : fallback;
}

export const RECRUITER_RUNTIME_STRATEGY_VERSION = "2026-06-09-search-card-fix-1";

function readSearchOptions(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const method = methods.find(
    (m) => m && typeof m === "object" && m.kind === "extract_strategy" && m.strategy === "recruiter_search_people",
  ) || {};
  return {
    targetCount: readPositiveInt(
      method.target_count ?? method.max_people ?? process.env.RECRUITER_SEARCH_TARGET_COUNT,
      null,
    ),
    maxPages: readPositiveInt(method.max_pages ?? process.env.RECRUITER_SEARCH_MAX_PAGES, 4),
    maxScrollPasses: readPositiveInt(
      method.max_scroll_passes ?? process.env.RECRUITER_SEARCH_MAX_SCROLL_PASSES,
      18,
    ),
  };
}

function readSaveResultsOptions(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const method = methods.find(
    (m) => m && typeof m === "object" && m.kind === "recruiter_save_results_to_project",
  ) || {};
  return {
    projectName: String(method.project_name ?? step?.value ?? "").trim(),
    targetCount: readPositiveInt(method.target_count ?? method.count ?? method.max_people, 1),
    mode: String(method.mode || "bulk").trim().toLowerCase(),
    maxScrollPasses: readPositiveInt(method.max_scroll_passes, 12),
  };
}

export function handlesStrategy(strategy) {
  return strategy === "recruiter_search_people"
    || strategy === "recruiter_save_results_to_project"
    || strategy === "recruiter_hot_reload_probe";
}

export async function runStrategy({ strategy, page, step, orand = Math.random, runtime = {} }) {
  if (strategy === "recruiter_hot_reload_probe") {
    return {
      handled: true,
      extraction: {
        hot_reload_probe: {
          strategy_version: RECRUITER_RUNTIME_STRATEGY_VERSION,
          url: page.url(),
          step_intent: step?.intent || "",
        },
      },
      log: `recruiter_hot_reload_probe version=${RECRUITER_RUNTIME_STRATEGY_VERSION}`,
    };
  }

  if (strategy === "recruiter_search_people") {
    const res = await scrapeRecruiterSearch(page, readSearchOptions(step), runtime);
    const people = Array.isArray(res) ? res : (res.people || []);
    const totalCount = Array.isArray(res) ? null : (res.total_count ?? null);
    const collectedCount = Array.isArray(res) ? people.length : (res.collected_count ?? people.length);
    return {
      handled: true,
      seenProfileUrls: people.map((p) => p.profile_url).filter(Boolean),
      extraction: {
        people,
        total_count: totalCount,
        collected_count: collectedCount,
        target_count: Array.isArray(res) ? null : (res.target_count ?? null),
        max_pages: Array.isArray(res) ? null : (res.max_pages ?? null),
      },
      log: `${people.length} candidates (recruiter search, collected=${collectedCount}, total=${totalCount})`,
    };
  }

  if (strategy === "recruiter_save_results_to_project") {
    const saveResult = await saveRecruiterResultsToProject(
      page,
      readSaveResultsOptions(step),
      orand,
      runtime,
    );
    return {
      handled: true,
      extraction: { save_result: saveResult },
      log: `recruiter_save_results_to_project ok=${saveResult.ok} selected=${saveResult.selected_count || 0} project="${saveResult.project_name || ""}" reason="${saveResult.reason || ""}"`,
    };
  }

  return { handled: false };
}

async function scrapeRecruiterSearch(page, options = {}, runtime = {}) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const viewportWidth = runtimeValue(runtime, "viewportWidth", 1440);
  const viewportHeight = runtimeValue(runtime, "viewportHeight", 900);

  // Search-results card selector. Covers the search-global (Copilot), advanced-search,
  // and project-pipeline list-element variants. MUST stay defined here — the extractPage
  // closure below interpolates it. (Regression: a refactor once dropped this and left a
  // stray ROW const, which broke recruiter_search_people with a ReferenceError.)
  const CARD = '[data-view-name^="talent-profile-list-element"]';
  await page.waitForSelector(`${CARD}, a[href*="/talent/profile/"]`, { timeout: 20000 }).catch(() => {});
  let prev = -1, stable = 0;
  for (let i = 0; i < 10; i++) {
    const n = await page.evaluate((s) => document.querySelectorAll(s).length, CARD).catch(() => 0);
    if (n > 0 && n === prev) { if (++stable >= 2) break; } else { stable = 0; }
    prev = n;
    await sleep(700);
  }
  const extractPage = (CARD) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const canon = (href) => {
      const m = (href || "").match(/\/talent\/(?:search\/)?profile\/[A-Za-z0-9_\-%]+/);
      return m ? "https://www.linkedin.com" + m[0] : "";
    };
    let total = null;
    const cm = (document.body.innerText || "").match(
      /([\d][\d.,]*)\s*\+?\s*(?:results|resultados|candidates|candidatos|perfiles|matches)/i,
    );
    if (cm) { const n = parseInt(cm[1].replace(/[.,]/g, ""), 10); if (!isNaN(n)) total = n; }
    const cards = [];
    for (const card of Array.from(document.querySelectorAll(CARD))) {
      const link = card.querySelector('a[href*="/talent/profile/"], a[href*="/talent/search/profile/"]');
      if (!link) continue;
      const name = clean(link.innerText || link.textContent);
      const url = canon(link.getAttribute("href"));
      if (!name || !url) continue;
      // Headline lives in the lockup subtitle (job title) — read it directly; it's
      // reliable across surfaces (locked offline from 03-results-populated.html where
      // the line-guessing heuristic was returning empty). Fall back to the heuristic.
      let headline = "";
      const sub = card.querySelector(".artdeco-entity-lockup__subtitle");
      if (sub) headline = clean(sub.innerText || sub.textContent);
      if (!headline) {
        for (const ln of clean(card.innerText).split("\n").map(clean).filter(Boolean)) {
          if (ln === name) continue;
          if (/^(seleccionar|select)\b/i.test(ln)) continue;
          if (/contacto de|grado|mutual|en común|^\d+\s*(º|°)/i.test(ln)) continue;
          headline = ln; break;
        }
      }
      cards.push({ name, profile_url: url, headline });
    }
    return { cards, total };
  };
  const byUrl = new Map();
  let totalCount = null;
  const collectVisible = async () => {
    const { cards, total } = await page.evaluate(extractPage, CARD);
    if (total != null && totalCount == null) totalCount = total;
    for (const c of cards) if (c.profile_url && !byUrl.has(c.profile_url)) byUrl.set(c.profile_url, c);
    return cards.length;
  };
  const pageState = async () => page.evaluate((sel) => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const y = root ? root.scrollTop : window.scrollY;
    const h = root ? root.clientHeight : window.innerHeight;
    const sh = root ? root.scrollHeight : document.body.scrollHeight;
    return {
      cards: document.querySelectorAll(sel).length,
      y,
      h,
      sh,
      atBottom: Math.ceil(y + h) >= sh - 24,
    };
  }, CARD).catch(() => ({ cards: 0, y: 0, h: 0, sh: 0, atBottom: false }));
  const scrollAndCollectPage = async () => {
    await collectVisible();
    let lastUnique = byUrl.size;
    let unchanged = 0;
    const maxScrollPasses = Math.max(8, readPositiveInt(options.maxScrollPasses, 18));
    for (let s = 0; s < maxScrollPasses; s++) {
      if (options.targetCount && byUrl.size >= options.targetCount) break;
      const before = await pageState();
      if (before.atBottom && unchanged >= 2) break;
      await moveMouseAlongBezier(
        page,
        { x: Math.floor(viewportWidth * (0.58 + Math.random() * 0.18)), y: Math.floor(viewportHeight * (0.62 + Math.random() * 0.16)) },
        Math.random,
      ).catch(() => {});
      await page.mouse.wheel(0, 620 + Math.floor(Math.random() * 420)).catch(() => {});
      await sleep(900 + Math.floor(Math.random() * 700));
      await collectVisible();
      const after = await pageState();
      if (byUrl.size === lastUnique && after.cards === before.cards) unchanged += 1;
      else unchanged = 0;
      lastUnique = byUrl.size;
      if (after.atBottom && unchanged >= 1) break;
      if (unchanged >= 4) break;
    }
    await collectVisible();
  };
  const clickNextPage = async () => {
    const beforeUrl = page.url();
    const beforeProfiles = await page.evaluate((sel) => Array.from(
      document.querySelectorAll(`${sel} a[href*="/talent/profile/"], ${sel} a[href*="/talent/search/profile/"]`),
    ).map((a) => a.getAttribute("href") || ""), CARD).catch(() => []);
    const target = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const selectors = [
        '[data-test-pagination-next]:not([disabled]):not([aria-disabled="true"])',
        'a[aria-label*="siguiente" i]:not([aria-disabled="true"])',
        'a[aria-label*="next" i]:not([aria-disabled="true"])',
        'button[aria-label*="Siguiente" i]:not([disabled]):not([aria-disabled="true"])',
        'button[aria-label*="Next" i]:not([disabled]):not([aria-disabled="true"])',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const cs = window.getComputedStyle(el);
        const disabled = el.matches("[disabled], [aria-disabled='true']") || cs.visibility === "hidden" || cs.display === "none";
        if (disabled) continue;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(350);
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }).catch(() => null);
    if (!target) return false;
    await moveMouseAlongBezier(page, target, Math.random).catch(() => {});
    await sleep(100 + Math.floor(Math.random() * 180));
    await page.mouse.click(target.x, target.y).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(({ sel, url, profiles }) => {
      if (location.href !== url) return true;
      const now = Array.from(
        document.querySelectorAll(`${sel} a[href*="/talent/profile/"], ${sel} a[href*="/talent/search/profile/"]`),
      ).map((a) => a.getAttribute("href") || "");
      return now.length > 0 && now.some((href) => !profiles.includes(href));
    }, { sel: CARD, url: beforeUrl, profiles: beforeProfiles }, { timeout: 15000 }).catch(() => {});
    await sleep(1600 + Math.floor(Math.random() * 900));
    return true;
  };
  const MAX_PAGES = Math.max(1, readPositiveInt(options.maxPages, 4));
  for (let pg = 0; pg < MAX_PAGES; pg++) {
    await scrollAndCollectPage();
    if (options.targetCount && byUrl.size >= options.targetCount) break;
    const wentNext = await clickNextPage();
    if (!wentNext) break;
    await page.waitForSelector(CARD, { timeout: 10000 }).catch(() => {});
  }
  const people = Array.from(byUrl.values());
  return {
    people: options.targetCount ? people.slice(0, options.targetCount) : people,
    total_count: totalCount,
    collected_count: byUrl.size,
    target_count: options.targetCount || null,
    max_pages: MAX_PAGES,
  };
}

async function clickSelectorChain(page, selectorChain, orand, timeoutMs, runtime) {
  const resolveLocatorWithWait = runtimeValue(runtime, "resolveLocatorWithWait", null);
  const clickResolved = runtimeValue(runtime, "clickResolved", null);
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  if (!resolveLocatorWithWait || !clickResolved) return false;
  const target = await resolveLocatorWithWait(page, selectorChain, { timeoutMs });
  if (!target) return false;
  try {
    return await clickResolved(page, target, { moveMouseAlongBezier, orand });
  } finally {
    await target.handle?.dispose?.().catch(() => {});
  }
}

async function typeSelectorChain(page, selectorChain, value, orand, timeoutMs, runtime) {
  const resolveLocatorWithWait = runtimeValue(runtime, "resolveLocatorWithWait", null);
  const clickResolved = runtimeValue(runtime, "clickResolved", null);
  const typeHumanLike = runtimeValue(runtime, "typeHumanLike", null);
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  if (!resolveLocatorWithWait || !clickResolved || !typeHumanLike) return false;
  const target = await resolveLocatorWithWait(page, selectorChain, { timeoutMs });
  if (!target) return false;
  try {
    const focused = await clickResolved(page, target, { moveMouseAlongBezier, orand });
    if (!focused) await target.handle.focus().catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {});
    await typeHumanLike(page, value, orand);
    return true;
  } finally {
    await target.handle?.dispose?.().catch(() => {});
  }
}

async function selectRecruiterResultCheckboxes(page, targetCount, orand, maxScrollPasses, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const ROW = '[data-test-paginated-profile-list-item-container], article.profile-list-item';
  const selected = [];
  const selectedUrls = new Set();
  const limit = Math.max(1, targetCount || 1);
  const passes = Math.max(1, maxScrollPasses || 12);
  for (let pass = 0; pass < passes && selected.length < limit; pass++) {
    const targets = await page.evaluate(({ rowSelector, seen, remaining }) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const canon = (href) => {
        const m = (href || "").match(/\/talent\/(?:search\/)?profile\/[A-Za-z0-9_\-%]+/);
        return m ? "https://www.linkedin.com" + m[0] : "";
      };
      const out = [];
      const seenSet = new Set(seen || []);
      for (const row of Array.from(document.querySelectorAll(rowSelector))) {
        if (out.length >= remaining) break;
        const link = row.querySelector('a[href*="/talent/profile/"], a[href*="/talent/search/profile/"]');
        const url = canon(link && link.getAttribute("href"));
        if (!url || seenSet.has(url)) continue;
        const input = row.querySelector('input.small-input[type="checkbox"], input.small-input');
        if (!input || input.disabled || input.checked) continue;
        const label = Array.from(row.querySelectorAll("label")).find(
          (candidate) => candidate.getAttribute("for") === input.id,
        );
        let box = null;
        for (const candidate of [input.closest(".profile-list-item__selector"), input.closest("label"), label, input].filter(Boolean)) {
          const r = candidate.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            box = r;
            break;
          }
        }
        if (!box) continue;
        out.push({
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
          inputId: input.id || "",
          url,
          name: clean(link && (link.innerText || link.textContent)),
        });
      }
      return out;
    }, { rowSelector: ROW, seen: Array.from(selectedUrls), remaining: limit - selected.length }).catch(() => []);
    for (const target of targets) {
      if (selected.length >= limit) break;
      await moveMouseAlongBezier(page, { x: target.x, y: target.y }, orand).catch(() => {});
      await sleep(80 + Math.floor(orand() * 140));
      await page.mouse.click(target.x, target.y).catch(() => {});
      await sleep(180 + Math.floor(orand() * 220));
      let checked = await page.evaluate((inputId) => {
        if (!inputId) return true;
        const el = document.getElementById(inputId);
        return Boolean(el && el.checked);
      }, target.inputId).catch(() => true);
      if (!checked && target.inputId) {
        await page.evaluate((inputId) => {
          const el = document.getElementById(inputId);
          if (el && !el.checked) el.click();
        }, target.inputId).catch(() => {});
        await sleep(180 + Math.floor(orand() * 220));
        checked = await page.evaluate((inputId) => {
          const el = document.getElementById(inputId);
          return Boolean(el && el.checked);
        }, target.inputId).catch(() => false);
      }
      if (!checked) continue;
      selectedUrls.add(target.url);
      selected.push({ profile_url: target.url, name: target.name || "" });
      await sleep(250 + Math.floor(orand() * 350));
    }
    if (selected.length >= limit) break;
    await page.mouse.wheel(0, 650 + Math.floor(orand() * 500)).catch(() => {});
    await sleep(900 + Math.floor(orand() * 700));
  }
  return selected;
}

async function clickRecruiterBulkSave(page, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const target = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const selectors = [
      '[data-test-profile-list-bulk-actions] button[data-test-action="save-to-project"]',
      '[data-test-profile-list-bulk-actions] [data-test-action="save-to-project"]',
      '[data-test-profile-list-bulk-actions] button[aria-label*="Guardar" i]',
      '[data-test-profile-list-bulk-actions] button[aria-label*="Save" i]',
      '.bulk-actions button[data-test-action="save-to-project"]',
      '.bulk-actions [data-test-action="save-to-project"]',
      '.profile-list__header button[data-test-action="save-to-project"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(350);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    const buttons = Array.from(document.querySelectorAll('button[data-test-action="save-to-project"]'));
    for (const el of buttons) {
      if (el.closest('[data-test-profile-list-view-list-row], [data-test-paginated-profile-list-item-container]')) continue;
      const text = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`;
      if (!/(guardar|save)/i.test(text)) continue;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(350);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }).catch(() => null);
  if (!target) return false;
  await moveMouseAlongBezier(page, target, orand).catch(() => {});
  await sleep(80 + Math.floor(orand() * 140));
  await page.mouse.click(target.x, target.y).catch(() => {});
  return true;
}

async function saveRecruiterResultsToProject(page, options, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const projectName = String(options.projectName || "").trim();
  if (!projectName) return { ok: false, reason: "missing_project_name" };
  const selected = await selectRecruiterResultCheckboxes(
    page,
    options.targetCount,
    orand,
    options.maxScrollPasses,
    runtime,
  );
  if (!selected.length) {
    const diagnostics = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-test-paginated-profile-list-item-container], article.profile-list-item').length,
      checkboxes: document.querySelectorAll('input.small-input[type="checkbox"], input.small-input').length,
      rowSelectors: document.querySelectorAll(".profile-list-item__selector").length,
    })).catch(() => null);
    return { ok: false, reason: "no_result_checkboxes_selected", selected_count: 0, diagnostics };
  }
  const openedBulkSave = await clickRecruiterBulkSave(page, orand, runtime);
  if (!openedBulkSave) {
    return {
      ok: false,
      reason: "bulk_save_button_not_found",
      selected_count: selected.length,
      selected,
      project_name: projectName,
    };
  }
  await page.waitForSelector('#save-to-projects-typeahead, label[for="choose-existing-projects"], [role="dialog"]', { timeout: 10000 }).catch(() => {});
  const existingModeClicked = await clickSelectorChain(page, [
    { type: "css", value: "label[for='choose-existing-projects']" },
    { type: "css", value: "#choose-existing-projects" },
  ], orand, 5000, runtime);
  const typedProject = await typeSelectorChain(page, [
    { type: "css", value: "#save-to-projects-typeahead" },
  ], projectName, orand, 10000, runtime);
  await sleep(1400 + Math.floor(orand() * 900));
  const pickedProject = await clickSelectorChain(page, [
    { type: "text", value: projectName },
  ], orand, 10000, runtime);
  await sleep(700 + Math.floor(orand() * 600));
  const clickedSave = await clickSelectorChain(page, [
    { type: "css", value: "button[data-test-action='save']" },
  ], orand, 10000, runtime);
  await sleep(1400 + Math.floor(orand() * 900));
  return {
    ok: Boolean(typedProject && pickedProject && clickedSave),
    selected_count: selected.length,
    selected,
    project_name: projectName,
    existing_mode_clicked: existingModeClicked,
    typed_project: typedProject,
    picked_project: pickedProject,
    clicked_save: clickedSave,
  };
}
