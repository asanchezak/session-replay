function readPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function runtimeValue(runtime, key, fallback) {
  return runtime && runtime[key] !== undefined ? runtime[key] : fallback;
}

export const RECRUITER_RUNTIME_STRATEGY_VERSION = "2026-06-11-archive-all-5";

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
    projectUrl: String(method.project_url ?? "").trim(),
    targetCount: readPositiveInt(method.target_count ?? method.count ?? method.max_people, 1),
    mode: String(method.mode || "bulk").trim().toLowerCase(),
    maxScrollPasses: readPositiveInt(method.max_scroll_passes, 12),
  };
}

function readArchiveOptions(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const method = methods.find(
    (m) => m && typeof m === "object" && m.kind === "recruiter_archive_candidate",
  ) || {};
  return {
    projectUrl: String(method.project_url ?? "").trim(),
    candidateName: String(method.candidate_name ?? step?.value ?? "").trim(),
    profileUrl: String(method.profile_url ?? "").trim(),
    maxPages: readPositiveInt(method.max_pages, 5),
  };
}

function readArchiveAllOptions(step) {
  const methods = Array.isArray(step?.methods) ? step.methods : [];
  const method = methods.find(
    (m) => m && typeof m === "object" && m.kind === "recruiter_archive_all_in_project",
  ) || {};
  return {
    projectUrl: String(method.project_url ?? step?.value ?? "").trim(),
    maxRounds: readPositiveInt(method.max_rounds, 15),
  };
}

export function handlesStrategy(strategy) {
  return strategy === "recruiter_search_people"
    || strategy === "recruiter_save_results_to_project"
    || strategy === "recruiter_archive_candidate"
    || strategy === "recruiter_archive_all_in_project"
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
      log: `recruiter_save_results_to_project ok=${saveResult.ok} saved=${saveResult.saved_count || 0}/${saveResult.target_count || 0} verified_in_project=${saveResult.verified_in_project} project="${saveResult.project_name || ""}" reason="${saveResult.reason || ""}"`,
    };
  }

  if (strategy === "recruiter_archive_candidate") {
    const archiveResult = await archiveRecruiterCandidate(
      page,
      readArchiveOptions(step),
      orand,
      runtime,
    );
    return {
      handled: true,
      extraction: { archive_result: archiveResult },
      log: `recruiter_archive_candidate ok=${archiveResult.ok} archived=${archiveResult.archived} verified_gone=${archiveResult.verified_gone} name="${archiveResult.candidate_name || ""}" reason="${archiveResult.reason || ""}"`,
    };
  }

  if (strategy === "recruiter_archive_all_in_project") {
    const r = await archiveAllInProject(page, readArchiveAllOptions(step), orand, runtime);
    return {
      handled: true,
      extraction: { archive_all_result: r },
      log: `recruiter_archive_all_in_project ok=${r.ok} archived_before=${r.archived_before} archived_after=${r.archived_after} rounds=${r.rounds} reason="${r.reason || ""}"`,
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

// Click the Recruiter results pager "Next" (an <a data-test-pagination-next> or an
// aria-labelled next/siguiente control). Returns false when there's no enabled next
// page. Selection persists in the bulk-action bar across pages, so we can keep
// checking candidates page after page until we reach the target.
async function clickResultsNextPage(page, sleep, moveMouseAlongBezier, orand) {
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
      if (el.matches("[disabled], [aria-disabled='true']") || cs.visibility === "hidden" || cs.display === "none") continue;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(350);
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }).catch(() => null);
  if (!target) return false;
  await moveMouseAlongBezier(page, target, orand).catch(() => {});
  await sleep(100 + Math.floor(orand() * 180));
  await page.mouse.click(target.x, target.y).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  return true;
}

async function selectRecruiterResultCheckboxes(page, targetCount, orand, maxScrollPasses, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const ROW = '[data-test-paginated-profile-list-item-container], article.profile-list-item';
  const selected = [];
  const selectedUrls = new Set();
  const limit = Math.max(1, targetCount || 1);
  const passes = Math.max(1, maxScrollPasses || 12);
  // Selects ONLY the current results page (Recruiter resets the checkbox selection
  // when you paginate, so cross-page select-then-save loses everything but the last
  // page — the page loop + save happens in saveRecruiterResultsToProject instead).
  let stale = 0;
  for (let pass = 0; pass < passes && selected.length < limit; pass++) {
    const before = selected.length;
    const targets = await page.evaluate(({ rowSelector, seen, remaining }) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      const canon = (href) => {
        const m = (href || "").match(/\/talent\/(?:search\/)?profile\/[A-Za-z0-9_\-%]+/);
        return m ? "https://www.linkedin.com" + m[0] : "";
      };
      const out = [];
      const seenSet = new Set(seen || []);
      // Dedup WITHIN this batch too: the ROW selector (paginated-container OR
      // article.profile-list-item) can match the same candidate's card twice
      // (nested/duplicate match), which otherwise selected the same person N times
      // and saved 1 unique instead of N. Guard by canonical profile URL AND by
      // checkbox input id.
      const batchUrls = new Set();
      const batchInputs = new Set();
      for (const row of Array.from(document.querySelectorAll(rowSelector))) {
        if (out.length >= remaining) break;
        const link = row.querySelector('a[href*="/talent/profile/"], a[href*="/talent/search/profile/"]');
        const url = canon(link && link.getAttribute("href"));
        if (!url || seenSet.has(url) || batchUrls.has(url)) continue;
        const input = row.querySelector('input.small-input[type="checkbox"], input.small-input');
        if (!input || input.disabled || input.checked) continue;
        if (input.id && batchInputs.has(input.id)) continue;
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
        batchUrls.add(url);
        if (input.id) batchInputs.add(input.id);
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
      if (selectedUrls.has(target.url)) continue;  // defensive: never select the same profile twice
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
    // No new selection this pass → the current page is exhausted; after a couple of
    // empty passes stop.
    if (selected.length === before) { if (++stale >= 2) break; } else { stale = 0; }
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

// One dialog cycle: open the bulk "save to project" dialog for the CURRENTLY
// selected candidates, pick the existing project by name, and confirm.
async function saveSelectionToProject(page, projectName, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const opened = await clickRecruiterBulkSave(page, orand, runtime);
  if (!opened) return { ok: false, reason: "bulk_save_button_not_found" };
  await page.waitForSelector('#save-to-projects-typeahead, label[for="choose-existing-projects"], [role="dialog"]', { timeout: 10000 }).catch(() => {});
  const existingModeClicked = await clickSelectorChain(page, [
    { type: "css", value: "label[for='choose-existing-projects']" },
    { type: "css", value: "#choose-existing-projects" },
  ], orand, 5000, runtime);
  const typedProject = await typeSelectorChain(page, [
    { type: "css", value: "#save-to-projects-typeahead" },
  ], projectName, orand, 10000, runtime);
  await sleep(1600 + Math.floor(orand() * 900));
  // Pick the typeahead option whose text matches the EXACT project name. The
  // typeahead lists ALL projects (it does not filter by the typed text), and the old
  // fuzzy text-click selected the WRONG project (candidates landed elsewhere) — so we
  // click the specific <li.artdeco-typeahead__result> that contains this exact name.
  const pickTarget = await page.evaluate((name) => {
    const opts = Array.from(document.querySelectorAll(
      'li.artdeco-typeahead__result[role="option"], ul[role="listbox"] li[role="option"], [role="option"]',
    ));
    for (const li of opts) {
      const txt = (li.textContent || "").replace(/\s+/g, " ");
      if (txt.includes(name)) {
        li.scrollIntoView({ block: "center" });
        const r = li.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + Math.min(140, r.width * 0.4), y: r.top + r.height / 2 };
        }
      }
    }
    return null;
  }, projectName).catch(() => null);
  let pickedProject = false;
  if (pickTarget) {
    await moveMouseAlongBezier(page, pickTarget, orand).catch(() => {});
    await sleep(120 + Math.floor(orand() * 160));
    await page.mouse.click(pickTarget.x, pickTarget.y).catch(() => {});
    pickedProject = true;
  }
  await sleep(900 + Math.floor(orand() * 600));
  // GUARD: only save if the selected project chip actually matches our target — never
  // save into the wrong project.
  const selectedRight = await page.evaluate((name) => {
    const chips = Array.from(document.querySelectorAll(
      '[class*="chip"], [class*="pill"], [class*="selected"], [data-test*="selected"]',
    ));
    return chips.some((e) => (e.textContent || "").replace(/\s+/g, " ").includes(name));
  }, projectName).catch(() => false);
  let clickedSave = false;
  if (selectedRight) {
    clickedSave = await clickSelectorChain(page, [
      { type: "css", value: "button[data-test-action='save']" },
    ], orand, 10000, runtime);
  }
  await sleep(1800 + Math.floor(orand() * 1000));  // let the "N guardados" toast settle
  const toast = await page.evaluate(() => {
    const m = (document.body.innerText || "").match(/Se han? guardado[^.\n]*|saved[^.\n]*to (?:the )?project[^.\n]*/i);
    return m ? m[0].trim().slice(0, 90) : null;
  }).catch(() => null);
  return {
    ok: Boolean(typedProject && pickedProject && selectedRight && clickedSave),
    existing_mode_clicked: existingModeClicked,
    typed_project: typedProject,
    picked_project: pickedProject,
    selected_right_project: selectedRight,
    clicked_save: clickedSave,
    toast,
  };
}

// Remove (= ARCHIVE; Recruiter has no hard-delete) a SINGLE candidate from a
// project's pipeline. On the project /manage/all page each candidate row carries a
// direct archive control `button[data-view-name='archive-profiles-btn']` whose
// accessibility label is "Archivar a <First>, ya que parece que no encajaría… /
// Archivar" — clicking it archives with the default "doesn't fit" reason (one click,
// no checkbox). We target the SPECIFIC candidate by matching that button's enclosing
// row (profile URL preferred, else full name), tag it, and click it with the
// daemon's actionability-aware clickResolved (hover/scroll/retry). VERIFICATION is
// the truth: the "Candidatos archivados / Archived candidates N" count must INCREASE
// (archived candidates still show in "Todos los candidatos", so absence there is the
// WRONG signal). Returns { ok, archived, verified_gone, archived_before/after,
// candidate_name, profile_url, reason }. The backend only deletes the Odoo lead when
// verified_gone, so an unconfirmed run is safe (lead stays pending, re-runnable).
async function archiveRecruiterCandidate(page, options, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const resolveLocatorWithWait = runtimeValue(runtime, "resolveLocatorWithWait", null);
  const clickResolved = runtimeValue(runtime, "clickResolved", null);
  const name = String(options.candidateName || "").trim();
  const profileUrl = String(options.profileUrl || "").trim();
  if (!name && !profileUrl) {
    return { ok: false, archived: false, verified_gone: false, reason: "missing_candidate_identity" };
  }
  const m = String(options.projectUrl || "").match(/\/talent\/hire\/(\d+)/);
  if (!m) return { ok: false, archived: false, verified_gone: false, candidate_name: name, reason: "missing_project_id" };
  const manageUrl = `https://www.linkedin.com/talent/hire/${m[1]}/manage/all`;
  const ARCHIVE_BTN = "[data-test-component='archive-profiles-btn'], [data-live-test-component='archive-profiles-btn']";
  const TARGET_SEL = "[data-sr-archive-target='1']";
  const maxPages = Math.max(1, options.maxPages || 5);

  // "Candidatos archivados / Archived candidates N" — the verification counter.
  const readArchivedCount = () => page.evaluate(() => {
    const bt = document.body.innerText || "";
    const mm = bt.match(/(?:Candidatos archivados|Archived candidates)\s*\n?\s*([\d][\d.,]*)/i);
    return mm ? parseInt(mm[1].replace(/[.,]/g, ""), 10) : null;
  }).catch(() => null);

  // Tag the target candidate's archive button. Each per-row archive control is
  // labelled "Archivar a <Name>, ya que…" / "Archive <Name>, because…" — i.e. the
  // button itself names the candidate, which is far more reliable than climbing the
  // DOM to a row (an ancestor holding a profile link can span many candidates). We
  // parse that label name and match it as a PREFIX of the target full name (so
  // "Daniel" matches "Daniel De León"); when several match we take the longest
  // (most specific) label. Returns {found, present}.
  const tagTarget = (wantName, wantUrl) => page.evaluate(({ wantName, wantUrl, btnSel }) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const canon = (href) => {
      const mm = (href || "").match(/\/talent\/(?:search\/)?profile\/[A-Za-z0-9_\-%]+/);
      return mm ? "https://www.linkedin.com" + mm[0] : "";
    };
    const target = clean(wantName);
    const wantCanon = canon(wantUrl);
    // Extract the candidate name from an archive button's a11y label.
    const labelName = (btn) => {
      const lab = clean(btn.getAttribute("aria-label") || btn.innerText || btn.textContent);
      const mm = lab.match(/^(?:archivar a|archive)\s+(.+?)(?:,| ya que| because|$)/i);
      return mm ? mm[1].trim() : "";
    };
    document.querySelectorAll("[data-sr-archive-target]").forEach((e) => e.removeAttribute("data-sr-archive-target"));
    document.querySelectorAll("[data-sr-archive-row]").forEach((e) => e.removeAttribute("data-sr-archive-row"));
    let best = null, bestLen = -1;
    for (const btn of Array.from(document.querySelectorAll(btnSel))) {
      const ln = labelName(btn);
      if (!ln || !target) continue;
      // Match when the label name is a prefix of the target (or vice-versa for
      // truncated labels). Prefer the longest label (most specific).
      const ok = target === ln || target.startsWith(ln + " ") || ln.startsWith(target + " ") || target === ln;
      if (ok && ln.length > bestLen) { best = btn; bestLen = ln.length; }
    }
    if (best) {
      best.setAttribute("data-sr-archive-target", "1");
      // The per-row action buttons (.profile-item-actions) are revealed on ROW
      // hover — tag the enclosing row so the caller can hover it before clicking.
      const row = best.closest("[data-test-profile-list-view-list-row], .profile-list-item, li");
      if (row) row.setAttribute("data-sr-archive-row", "1");
      best.scrollIntoView({ block: "center" });
      return { found: true, present: true, matched_name: labelName(best), has_row: !!row };
    }
    // Not tagged — is the candidate present at all (any profile link / archive label)?
    let present = false;
    for (const link of Array.from(document.querySelectorAll('a[href*="/talent/profile/"]'))) {
      const url = canon(link.getAttribute("href"));
      const rowName = clean(link.innerText || link.textContent);
      if ((wantCanon && url && url === wantCanon)
          || (target && rowName && (rowName === target || rowName.includes(target) || target.includes(rowName)))) {
        present = true; break;
      }
    }
    if (!present) {
      for (const btn of Array.from(document.querySelectorAll(btnSel))) {
        const ln = labelName(btn);
        if (ln && target && (target.startsWith(ln) || ln.startsWith(target))) { present = true; break; }
      }
    }
    return { found: false, present };
  }, { wantName, wantUrl, btnSel: ARCHIVE_BTN }).catch(() => ({ found: false, present: false }));

  const clickTagged = async () => {
    // Reveal the row's hover-gated action buttons first (the archive control lives in
    // .profile-item-actions, hidden until the row is hovered).
    await page.hover("[data-sr-archive-row]").catch(() => {});
    await sleep(450 + Math.floor(orand() * 350));
    if (resolveLocatorWithWait && clickResolved) {
      const t = await resolveLocatorWithWait(page, [{ type: "css", value: TARGET_SEL }], { timeoutMs: 8000 });
      if (t) {
        try { return await clickResolved(page, t, { moveMouseAlongBezier, orand }); }
        finally { await t.handle?.dispose?.().catch(() => {}); }
      }
    }
    // Fallback: keep the row hovered, then trusted coordinate click on the button.
    const pt = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }, TARGET_SEL).catch(() => null);
    if (!pt) return false;
    await moveMouseAlongBezier(page, pt, orand).catch(() => {});
    await sleep(120 + Math.floor(orand() * 200));
    await page.mouse.click(pt.x, pt.y).catch(() => {});
    return true;
  };

  try {
    await page.goto(manageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(ARCHIVE_BTN, { timeout: 20000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await sleep(1500 + Math.floor(orand() * 800));
    const archivedBefore = await readArchivedCount();

    // Find + tag the candidate (paginate if needed).
    let loc = { found: false, present: false };
    for (let pg = 0; pg < maxPages; pg++) {
      loc = await tagTarget(name, profileUrl);
      if (loc.found || loc.present) break;
      const wentNext = await clickResultsNextPage(page, sleep, moveMouseAlongBezier, orand);
      if (!wentNext) break;
      await page.waitForSelector(ARCHIVE_BTN, { timeout: 10000 }).catch(() => {});
      await sleep(1500 + Math.floor(orand() * 700));
    }

    // Already absent → removal satisfied (idempotent).
    if (!loc.found && !loc.present) {
      return { ok: true, archived: false, verified_gone: true, candidate_name: name,
               profile_url: profileUrl || null, archived_before: archivedBefore,
               reason: "not_present", manage_url: manageUrl };
    }
    if (!loc.found) {
      return { ok: false, archived: false, verified_gone: false, candidate_name: name,
               profile_url: profileUrl || null, archived_before: archivedBefore,
               reason: "archive_button_not_found", manage_url: manageUrl };
    }

    const clicked = await clickTagged();
    await sleep(1600 + Math.floor(orand() * 700));  // let the dropdown/menu render

    // DIAGNOSTIC: capture what the archive click produced (a confirm dialog, a
    // dropdown reason-picker, a snackbar, …) so we can tune the confirm step from a
    // single run instead of guessing. Dumps the surface's element inventory + HTML.
    const postClick = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
      const body = document.querySelector("[data-test-archive-confirm-modal-body]");
      const cont = (body && body.closest(".artdeco-modal, [role='dialog']")) || document.querySelector(".artdeco-modal, [role='dialog'][aria-modal='true'], [role='alertdialog']");
      const clickables = (root) => Array.from(root.querySelectorAll("button, [role='menuitem'], [role='option'], [role='button'], a, li, input")).filter(vis).map((b) => `${b.tagName.toLowerCase()}${b.getAttribute("role") ? "[" + b.getAttribute("role") + "]" : ""}: ${((b.innerText || b.textContent || "") + " | " + (b.getAttribute("aria-label") || "")).replace(/\s+/g, " ").trim().slice(0, 60)}`).filter((s) => s.length > 12).slice(0, 25);
      const snackbar = (document.body.innerText || "").match(/[^\n]*\b(archivad|archived|deshacer|undo)\b[^\n]*/i);
      return {
        container_found: !!cont,
        container_kind: cont ? (cont.getAttribute("role") || cont.className || cont.tagName).slice(0, 60) : null,
        clickables: cont ? clickables(cont) : clickables(document.body).slice(0, 15),
        container_html: cont ? cont.outerHTML.replace(/\s+/g, " ").slice(0, 1800) : null,
        snackbar: snackbar ? snackbar[0].trim().slice(0, 100) : null,
      };
    }).catch(() => null);

    // Clicking the per-row archive button opens a confirmation MODAL
    // (data-test-archive-confirm-modal-body) whose action buttons live in the modal
    // FOOTER (.artdeco-modal__actionbar) — a SIBLING of __content. So scope to the
    // whole modal ROOT and click its primary "Archivar"/confirm button (NOT Cancelar).
    const confirmPt = await page.evaluate(() => {
      const body = document.querySelector("[data-test-archive-confirm-modal-body]");
      const surface = (body && body.closest(".artdeco-modal, [role='dialog']"))
        || document.querySelector(".artdeco-modal, [role='dialog'][aria-modal='true'], [role='alertdialog']");
      if (!surface) return null;
      // Precise submit button first (live-confirmed selector), then fall back to a
      // text match in the footer — never the Cancelar/dismiss controls.
      const submit = surface.querySelector(
        "button[data-test-archive-confirm-modal-submit], button[data-test-dialog-primary-btn], button[data-test-modal-confirm-btn]");
      const ptOf = (b) => { b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return (r.width > 0 && r.height > 0) ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; };
      if (submit) { const p = ptOf(submit); if (p) return p; }
      for (const b of Array.from(surface.querySelectorAll(".artdeco-modal__actionbar button, button"))) {
        if (b.matches("[data-test-archive-confirm-modal-cancel], [data-test-modal-close-btn], .artdeco-modal__dismiss")) continue;
        const t = ((b.innerText || b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
        if (/\b(archivar|archive|confirmar|confirm)\b/.test(t) && !/\b(cancelar|cancel|descartar)\b/.test(t)) {
          const p = ptOf(b); if (p) return p;
        }
      }
      return null;
    }).catch(() => null);
    if (confirmPt) {
      await moveMouseAlongBezier(page, confirmPt, orand).catch(() => {});
      await sleep(120 + Math.floor(orand() * 200));
      await page.mouse.click(confirmPt.x, confirmPt.y).catch(() => {});
      await sleep(1200 + Math.floor(orand() * 600));
    }
    await sleep(1500 + Math.floor(orand() * 800));  // let the archive apply

    // VERIFY via the archived counter (reload so it reflects the change).
    await page.goto(manageUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForSelector(ARCHIVE_BTN, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    let archivedAfter = null;
    for (let i = 0; i < 6; i++) {
      await sleep(1800);
      archivedAfter = await readArchivedCount();
      if (archivedAfter != null && archivedBefore != null && archivedAfter > archivedBefore) break;
    }
    // Diagnostic only (paginate so it's meaningful): is the candidate still in the
    // ACTIVE pipeline anywhere?
    let stillActive = false;
    for (let pg = 0; pg < maxPages; pg++) {
      if ((await tagTarget(name, profileUrl)).found) { stillActive = true; break; }
      const wentNext = await clickResultsNextPage(page, sleep, moveMouseAlongBezier, orand);
      if (!wentNext) break;
      await page.waitForSelector(ARCHIVE_BTN, { timeout: 8000 }).catch(() => {});
      await sleep(1000 + Math.floor(orand() * 500));
    }
    await sleep(1000);  // settle before the per-step snapshot

    // TRUTH = the archived counter increased. (Archived candidates still appear in
    // "Todos los candidatos", so absence there is NOT proof — the count is.)
    const verifiedGone = archivedAfter != null && archivedBefore != null && archivedAfter > archivedBefore;
    return {
      ok: verifiedGone,
      archived: verifiedGone,
      verified_gone: verifiedGone,
      candidate_name: name,
      profile_url: profileUrl || null,
      archived_before: archivedBefore,
      archived_after: archivedAfter,
      clicked,
      still_active: stillActive,
      post_click: postClick,
      manage_url: manageUrl,
      ...(verifiedGone ? {} : { reason: "archived_count_unchanged" }),
    };
  } catch (e) {
    return { ok: false, archived: false, verified_gone: false, candidate_name: name,
             profile_url: profileUrl || null, reason: `error:${(e && e.message) || e}` };
  }
}

// Remove ALL candidates from a project (= archive everyone). The select-all+bulk path
// proved unreliable (no bulk archive-profiles-btn surfaces), so this loops the PROVEN
// single-archive interaction in place: pick the FIRST active candidate row, hover it
// to reveal the archive control, click it, confirm in the modal footer, let the SPA
// drop the row, repeat. Driven by the "Todos los candidatos" counter (which EXCLUDES
// archived) → stop at 0. Bounded by a per-candidate cap + a hard time budget (the
// daemon kills a step at 240s). Returns { ok, archived_before/after,
// active_start/after, archived_count, reason }.
async function archiveAllInProject(page, options, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const resolveLocatorWithWait = runtimeValue(runtime, "resolveLocatorWithWait", null);
  const clickResolved = runtimeValue(runtime, "clickResolved", null);
  const m = String(options.projectUrl || "").match(/\/talent\/hire\/(\d+)/);
  if (!m) return { ok: false, archived_before: null, archived_after: null, reason: "missing_project_id" };
  const manageUrl = `https://www.linkedin.com/talent/hire/${m[1]}/manage/all`;
  const ARCHIVE_BTN = "[data-test-component='archive-profiles-btn'], [data-live-test-component='archive-profiles-btn']";
  const ROW_SEL = "[data-test-profile-list-view-list-row], .profile-list-item, li";

  const readCounts = () => page.evaluate(() => {
    const bt = document.body.innerText || "";
    const num = (re) => { const mm = bt.match(re); return mm ? parseInt(mm[1].replace(/[.,]/g, ""), 10) : null; };
    return {
      archived: num(/(?:Candidatos archivados|Archived candidates)\s*\n?\s*([\d][\d.,]*)/i),
      total: num(/(?:Todos los candidatos|All candidates)\s*\n?\s*([\d][\d.,]*)/i),
    };
  }).catch(() => ({ archived: null, total: null }));

  // Tag the FIRST per-row archive button + its row. Does NOT filter by visibility —
  // the .profile-item-actions buttons are display:none until the row is hovered, so
  // the caller hovers the tagged row to reveal it (same as single-candidate archive).
  const tagFirst = () => page.evaluate((btnSel) => {
    document.querySelectorAll("[data-sr-arch-t]").forEach((e) => e.removeAttribute("data-sr-arch-t"));
    document.querySelectorAll("[data-sr-arch-r]").forEach((e) => e.removeAttribute("data-sr-arch-r"));
    const rows = Array.from(document.querySelectorAll("[data-test-profile-list-view-list-row], .profile-list-item")).filter((r) => r.querySelector('a[href*="/talent/profile/"]'));
    for (const row of rows) {
      const btn = row.querySelector(btnSel);
      if (!btn) continue;
      btn.setAttribute("data-sr-arch-t", "1");
      row.setAttribute("data-sr-arch-r", "1");
      row.scrollIntoView({ block: "center" });
      return { found: true, rows: rows.length };
    }
    return { found: false, rows: rows.length };
  }, ARCHIVE_BTN).catch(() => ({ found: false }));

  const clickSel = async (sel) => {
    const pt = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }, sel).catch(() => null);
    if (!pt) return false;
    await moveMouseAlongBezier(page, pt, orand).catch(() => {});
    await sleep(110 + Math.floor(orand() * 160));
    await page.mouse.click(pt.x, pt.y).catch(() => {});
    return true;
  };

  const BUDGET_MS = 175000;
  const t0 = Date.now();

  try {
    await page.goto(manageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector(`${ARCHIVE_BTN}, [data-live-test-select-all]`, { timeout: 20000 }).catch(() => {});
    await sleep(1500 + Math.floor(orand() * 500));
    const c0 = await readCounts();
    const archivedBefore = c0.archived;
    const activeStart = c0.total;

    // Archive one candidate per iteration → allow plenty (the 175s budget is the real
    // limiter). Floor at 40 so a small workflow max_rounds doesn't stop us early.
    const cap = Math.min(Math.max(options.maxRounds || 40, 40), 60);
    let archivedCount = 0;
    let reason = null;
    let stale = 0;
    let prevArchived = archivedBefore;
    for (let i = 0; i < cap && Date.now() - t0 < BUDGET_MS - 15000; i++) {
      const c = await readCounts();
      if (c.total != null && c.total <= 0) { reason = "all_archived"; break; }

      const loc = await tagFirst();
      if (!loc.found) {
        // No candidate rows at all → done; rows present but no button → selector issue.
        reason = (loc.rows === 0) ? "all_archived" : "archive_button_not_found";
        break;
      }

      // Hover the row to reveal the action, then click the archive control.
      await page.hover("[data-sr-arch-r]").catch(() => {});
      await sleep(380 + Math.floor(orand() * 280));
      let clicked = false;
      if (resolveLocatorWithWait && clickResolved) {
        const t = await resolveLocatorWithWait(page, [{ type: "css", value: "[data-sr-arch-t]" }], { timeoutMs: 6000 });
        if (t) { try { clicked = await clickResolved(page, t, { moveMouseAlongBezier, orand }); } finally { await t.handle?.dispose?.().catch(() => {}); } }
      }
      if (!clicked) clicked = await clickSel("[data-sr-arch-t]");
      await sleep(900 + Math.floor(orand() * 400));

      // Confirm in the modal footer.
      const confirmed = await clickSel("[data-test-archive-confirm-modal-submit], .artdeco-modal__actionbar button.artdeco-button--primary");
      if (!confirmed) { reason = "confirm_submit_not_found"; break; }
      await sleep(2200 + Math.floor(orand() * 700));  // archive applies; SPA drops the row

      // Progress check via the archived counter (avoids re-archiving loops).
      const c2 = await readCounts();
      if (c2.archived != null && prevArchived != null && c2.archived > prevArchived) {
        archivedCount += (c2.archived - prevArchived);
        prevArchived = c2.archived;
        stale = 0;
      } else {
        stale++;
        if (stale >= 2) { reason = "no_progress"; break; }
      }
    }

    await sleep(1200);
    const cf = await readCounts();
    const archivedAfter = cf.archived;
    const activeAfter = cf.total;
    const ok = (activeAfter != null && activeAfter <= 0)
      || (archivedBefore != null && archivedAfter != null && archivedAfter > archivedBefore);
    return {
      ok,
      archived_before: archivedBefore,
      archived_after: archivedAfter,
      active_start: activeStart,
      active_after: activeAfter,
      archived_count: archivedCount,
      manage_url: manageUrl,
      ...(reason ? { reason } : {}),
    };
  } catch (e) {
    return { ok: false, archived_before: null, archived_after: null, reason: `error:${(e && e.message) || e}` };
  }
}

async function saveRecruiterResultsToProject(page, options, orand, runtime) {
  const sleep = runtimeValue(runtime, "sleep", (ms) => new Promise((r) => setTimeout(r, ms)));
  const moveMouseAlongBezier = runtimeValue(runtime, "moveMouseAlongBezier", async () => {});
  const projectName = String(options.projectName || "").trim();
  if (!projectName) return { ok: false, reason: "missing_project_name" };
  const limit = Math.max(1, options.targetCount || 1);
  const maxPages = Math.max(1, Math.ceil(limit / 12) + 2);

  // Save PAGE BY PAGE: Recruiter clears the checkbox selection on pagination, so we
  // select the current page, save that batch to the project, then advance — instead
  // of select-all-then-save-once (which only saved the last page).
  const savedAll = [];
  const pageResults = [];
  let firstPageDiag = null;
  for (let pg = 0; pg < maxPages && savedAll.length < limit; pg++) {
    const remaining = limit - savedAll.length;
    const selected = await selectRecruiterResultCheckboxes(page, remaining, orand, options.maxScrollPasses, runtime);
    if (!selected.length) {
      if (pg === 0) {
        firstPageDiag = await page.evaluate(() => ({
          rows: document.querySelectorAll('[data-test-paginated-profile-list-item-container], article.profile-list-item').length,
          checkboxes: document.querySelectorAll('input.small-input[type="checkbox"], input.small-input').length,
        })).catch(() => null);
      }
      break;
    }
    const dlg = await saveSelectionToProject(page, projectName, orand, runtime);
    pageResults.push({ page: pg, selected: selected.length, ...dlg });
    if (!dlg.ok) break;  // dialog failed — stop, report what we saved so far
    savedAll.push(...selected);
    if (savedAll.length >= limit) break;
    const wentNext = await clickResultsNextPage(page, sleep, moveMouseAlongBezier, orand);
    if (!wentNext) break;
    await page.waitForSelector('[data-test-paginated-profile-list-item-container], article.profile-list-item', { timeout: 10000 }).catch(() => {});
    await sleep(1500 + Math.floor(orand() * 800));
  }

  // --- VERIFICATION: land on the project's candidate list so the daemon's per-step
  // snapshot captures it (visual proof), and read back how many candidates the
  // project actually holds. ---
  let verifiedInProject = null;
  let verifyUrl = "";
  const m = String(options.projectUrl || "").match(/\/talent\/hire\/(\d+)/);
  if (m) {
    verifyUrl = `https://www.linkedin.com/talent/hire/${m[1]}/manage/all`;
    try {
      await page.goto(verifyUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      // The project's candidate counts load lazily — poll up to ~16s for the
      // "Todos los candidatos / All candidates N" total before snapshotting.
      const readCount = () => page.evaluate(() => {
        const bt = document.body.innerText || "";
        const m1 = bt.match(/(?:Todos los candidatos|All candidates)\s*\n?\s*([\d][\d.,]*)/i);
        if (m1) return parseInt(m1[1].replace(/[.,]/g, ""), 10);
        // Fallback: the "N Candidatos guardados / N saved" spotlight.
        const m2 = bt.match(/([\d][\d.,]*)\s*(?:Candidatos guardados|saved candidates)/i);
        return m2 ? parseInt(m2[1].replace(/[.,]/g, ""), 10) : null;
      }).catch(() => null);
      for (let i = 0; i < 8; i++) {
        await sleep(2000);
        verifiedInProject = await readCount();
        if (verifiedInProject && verifiedInProject > 0) break;
      }
      await sleep(1500);  // settle before the per-step snapshot captures the page
    } catch { /* verification nav is best-effort */ }
  }

  const savedCount = savedAll.length;
  return {
    ok: savedCount > 0,
    saved_count: savedCount,
    target_count: limit,
    selected: savedAll,
    project_name: projectName,
    verified_in_project: verifiedInProject,
    verify_url: verifyUrl || null,
    pages: pageResults,
    ...(savedCount === 0 ? { reason: "no_result_checkboxes_selected", diagnostics: firstPageDiag } : {}),
  };
}
