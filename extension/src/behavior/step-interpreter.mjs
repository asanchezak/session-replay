/**
 * Shared, runtime-agnostic step-interpretation logic — the single source of truth
 * for the PURE decisions both executors make: selector-chain ordering, the
 * value-format parsers (accessibility / shadow_css / anchor), the xpath safety
 * guard, text normalization, and success-condition predicates.
 *
 * WHY this exists: the extension's replay.ts and the daemon's selector-resolve.mjs
 * each re-derived these, and they drifted (an account got flagged from
 * extension/daemon divergence). This module is imported by BOTH so the
 * decision logic can't drift again.
 *
 * What this module deliberately does NOT contain: anything that touches a DOM or
 * a Playwright page. Element FINDING (querySelector / getByRole / evaluateHandle)
 * and ACTING (click / type) stay in the per-runtime adapters, because their I/O
 * differs (sync DOM Element vs async Playwright Locator/Handle). The daemon's
 * in-page resolveChainInPage additionally CANNOT import this module — it is
 * serialized via page.evaluateHandle and must be self-contained — so it keeps its
 * own copy of the parsers/ordering, guarded against drift by a conformance test
 * (test_step_interpreter_conformance).
 *
 * Pure functions only → property-testable.
 */

/** Sort a selector_chain by descending score (stable, non-mutating). */
export function orderSelectorChain(chain) {
  return [...(Array.isArray(chain) ? chain : [])].sort((a, b) => (b.score || 0) - (a.score || 0));
}

/** XPath expressions using these functions are rejected (perf / injection guard). */
const DANGEROUS_XPATH = /count\(|string-length\(|substring\(|name\(|translate\(|normalize-space\(/i;
export function isDangerousXPath(xpath) {
  return DANGEROUS_XPATH.test(String(xpath || ""));
}

/** NFKD-fold, strip accents, collapse whitespace, lowercase. Used for SELECTOR
 *  text/accessibility matching (accent-insensitive). */
export function normalizeText(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Collapse whitespace + lowercase, but DO NOT fold accents. Used for
 *  success-CONDITION text comparison — intentionally less aggressive than
 *  normalizeText (matches replay.ts's _normalizeForCheck). */
export function normalizeForCheck(value) {
  return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Parse an `accessibility` selector value into { role, label }. Accepts a JSON
 * array [role,label], a JSON object {role,label|name}, "role[text='label']",
 * "role|label", "<role> <label>", or a bare label. Mirrors replay.ts exactly.
 */
export function parseAccessibility(data) {
  let role = "";
  let label = "";
  const raw = String(data == null ? "" : data);
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      role = String(parsed[0] || "");
      label = String(parsed[1] || "");
    } else if (parsed && typeof parsed === "object") {
      role = String(parsed.role || "");
      label = String(parsed.label || parsed.name || "");
    }
  } catch {
    const bracket = raw.match(/^([a-zA-Z]+)\s*\[\s*text\s*=\s*['"](.+?)['"]\s*\]$/);
    if (bracket) {
      role = bracket[1] || "";
      label = bracket[2] || "";
    } else if (raw.includes("|")) {
      const parts = raw.split("|");
      role = parts[0] || "";
      label = parts[1] || "";
    } else {
      const roleWord = raw.match(/^(button|link|textbox|combobox|menuitem|tab)\s+(.+)$/i);
      if (roleWord) {
        role = roleWord[1] || "";
        label = roleWord[2] || "";
      } else {
        label = raw;
      }
    }
  }
  return { role, label };
}

/** Parse a `shadow_css` value into { hostChain, target }, or null if malformed. */
export function parseShadowCss(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw == null ? "" : raw));
  } catch {
    return null;
  }
  const hostChain = Array.isArray(parsed.host_chain) ? parsed.host_chain : [];
  const target = String(parsed.target || "");
  if (!target) return null;
  return { hostChain, target };
}

/** Parse an `anchor` value into { anchorSelector, offsetX, offsetY, relation }, or null. */
export function parseAnchor(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value == null ? "" : value));
  } catch {
    return null;
  }
  if (!parsed || !parsed.anchor_selector) return null;
  return {
    anchorSelector: parsed.anchor_selector,
    offsetX: parsed.offset_x || 0,
    offsetY: parsed.offset_y || 0,
    relation: parsed.relation || "",
  };
}

/**
 * Evaluate a step.success_condition against runtime-provided VALUES (already
 * fetched by the adapter — keeps this pure/sync; DOM reads are sync, Playwright
 * reads are awaited before calling). Returns { ok, reason }.
 *
 * values: { pageText?, currentUrl?, inputValue?, selectorFound? }
 *   - pageText: document.body.innerText (for visible_text_contains)
 *   - currentUrl: location.href (for url_contains)
 *   - inputValue: the target element's value/text (for input_value_contains)
 *   - selectorFound: bool, whether the condition's selector resolved (selector_exists)
 *
 * Unknown / missing condition types pass (ok:true) — same lenient contract as
 * replay.ts (a condition we don't understand never fails a step).
 */
export function evaluateSuccessCondition(condition, values = {}) {
  if (!condition || typeof condition !== "object") return { ok: true };
  const ctype = String(condition.type || "").toLowerCase().trim();
  if (!ctype) return { ok: true };

  if (ctype === "visible_text_contains") {
    const expected = normalizeForCheck(String(condition.value || ""));
    if (!expected) return { ok: true };
    if (normalizeForCheck(values.pageText || "").includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:visible_text_contains" };
  }

  if (ctype === "url_contains") {
    const expected = String(condition.value || "");
    if (!expected) return { ok: true };
    if (String(values.currentUrl || "").includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:url_contains" };
  }

  if (ctype === "input_value_contains") {
    const expected = normalizeForCheck(String(condition.value || ""));
    if (!expected) return { ok: true };
    if (values.inputValue == null) {
      return { ok: false, reason: "SUCCESS_CONDITION_FAILED:input_value_contains_no_target" };
    }
    if (normalizeForCheck(String(values.inputValue)).includes(expected)) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:input_value_contains_mismatch" };
  }

  if (ctype === "selector_exists") {
    if (values.selectorFound) return { ok: true };
    return { ok: false, reason: "SUCCESS_CONDITION_FAILED:selector_exists_not_found" };
  }

  return { ok: true };
}

/** Which runtime-value keys a success_condition needs the adapter to fetch. */
export function successConditionInputs(condition) {
  const ctype = String((condition && condition.type) || "").toLowerCase().trim();
  switch (ctype) {
    case "visible_text_contains": return ["pageText"];
    case "url_contains": return ["currentUrl"];
    case "input_value_contains": return ["inputValue"];
    case "selector_exists": return ["selectorFound"];
    default: return [];
  }
}
