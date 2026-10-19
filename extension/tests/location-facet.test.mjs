// Unit tests for the geography helpers behind the search location facet and the
// recommendations filter. Pure functions — no seat/browser. Run:
// `node --test extension/tests/location-facet.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLocationSpec, locationSpecTerms, normalizeLocationText,
  pickLocationSuggestion, locationAllowed, stageVerdict,
} from "../runtime-strategies/recruiter.mjs";

test("spec parsing: entries by ';', spellings by '|'", () => {
  assert.deepEqual(parseLocationSpec("Costa Rica"), [["Costa Rica"]]);
  assert.deepEqual(parseLocationSpec("Costa Rica; Brazil|Brasil"),
    [["Costa Rica"], ["Brazil", "Brasil"]]);
  assert.deepEqual(locationSpecTerms("Costa Rica; Brazil|Brasil"),
    ["Costa Rica", "Brazil", "Brasil"]);
});

test("spec parsing: blank and UNRESOLVED placeholders mean 'no filter'", () => {
  // A global position threads no location at all -> "{{location}}" survives the
  // substitution and must never be typed into the facet.
  assert.deepEqual(parseLocationSpec("{{location}}"), []);
  assert.deepEqual(parseLocationSpec(""), []);
  assert.deepEqual(parseLocationSpec(null), []);
  assert.deepEqual(parseLocationSpec(" ; ; "), []);
});

test("suggestion pick: EXACT normalized match only (accent/case-insensitive)", () => {
  assert.equal(pickLocationSuggestion("Costa Rica", ["Costa Rica", "Provincia de San José, Costa Rica"]), 0);
  assert.equal(pickLocationSuggestion("Mexico", ["Ciudad de México, México", "México"]), 1);
  // the regression: "Latin America" matches nothing -> click nothing (and fail the run)
  assert.equal(pickLocationSuggestion("Latin America", ["Latin American Studies", "América Latina"]), -1);
  // a metro must never stand in for the country
  assert.equal(pickLocationSuggestion("Costa Rica", ["Provincia de San José, Costa Rica"]), -1);
  assert.equal(pickLocationSuggestion("Costa Rica", []), -1);
});

test("location filter: matches only at the END of the displayed location", () => {
  const latam = locationSpecTerms("Costa Rica; Panama|Panamá; Brazil|Brasil");
  assert.equal(locationAllowed("San José, Costa Rica", latam), true);
  assert.equal(locationAllowed("Costa Rica", latam), true);
  assert.equal(locationAllowed("São Paulo, Brasil", latam), true);
  // the trap: a US city named after a LATAM country
  assert.equal(locationAllowed("Panama City, Florida, United States", latam), false);
  assert.equal(locationAllowed("Bengaluru, Karnataka, India", latam), false);
  assert.equal(locationAllowed("Seattle, Washington, United States", latam), false);
});

test("location filter: no terms = no filter; unreadable location = fail closed", () => {
  assert.equal(locationAllowed("Bengaluru, India", []), true);
  assert.equal(locationAllowed("", locationSpecTerms("Costa Rica")), false);
  assert.equal(locationAllowed(null, locationSpecTerms("Costa Rica")), false);
});

test("stage gate: nothing applied fails the run; a skipped (global) spec passes", () => {
  const v = (extraction) => stageVerdict({ strategy: "recruiter_apply_locations", eventKind: "recruiter_search", extraction });
  assert.equal(v({ apply_locations_result: { ok: true, applied: ["Costa Rica"] } }).ok, true);
  assert.equal(v({ apply_locations_result: { ok: true, skipped: true, reason: "no_location" } }).ok, true);
  const bad = v({ apply_locations_result: { ok: false, reason: "no_location_applied" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "no_location_applied");
  // a facet that never opened must fail too, with its own reason
  assert.equal(v({ apply_locations_result: { ok: false, reason: "facet_not_open" } }).reason, "facet_not_open");
});

test("recommendations gate: 'everything was out of geography' is a success, not a failure", () => {
  const v = (r) => stageVerdict({ strategy: "recruiter_save_recommendations", eventKind: "recruiter_recommendations", extraction: { save_recommendations_result: r } });
  assert.equal(v({ ok: true, saved: 3 }).ok, true);
  assert.equal(v({ ok: true, saved: 0, no_recommendations: true, reason: "all_out_of_location" }).ok, true);
  assert.equal(v({ ok: false, reason: "missing_project_id" }).ok, false);
});

// --------------------------------------------------------------------------- offline
// Selector + filter against a REAL saved Automated-Sourcing page (the practice for this
// account: tune /talent selectors offline, never by reloading the live seat). The
// recommendations rows expose their location as `data-test-row-lockup-location` — NOT
// the `artdeco-entity-lockup__caption` a search card uses, which is why the strategy
// tries the data-test attribute FIRST.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SNAPSHOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../recruiter-snapshots/17bad0bb-b4ee-468d-b9f2-79be9c4960df/step-2-scroll.html",
);

test("recommendations rows: the real page's locations pass the LATAM filter", { skip: !existsSync(SNAPSHOT) && "snapshot not in this checkout" }, () => {
  const html = readFileSync(SNAPSHOT, "utf8");
  const found = [...html.matchAll(/data-test-row-lockup-location[^>]*>(.{0,200}?)<\//gs)]
    .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  assert.ok(found.length >= 5, `expected the row-location attribute to still exist, got ${found.length}`);
  const latam = locationSpecTerms(
    "Costa Rica;México|Mexico;Colombia;Argentina;Brasil|Brazil;Chile;Perú|Peru;Uruguay;"
    + "Guatemala;Panamá|Panama;República Dominicana|Dominican Republic;Ecuador");
  for (const loc of found) {
    assert.equal(locationAllowed(loc, latam), true, `real location rejected: ${loc}`);
  }
  // …and the shapes that were actually reaching the pipeline stay out.
  for (const loc of ["Bengaluru, Karnataka, India", "Seattle, Washington, United States",
                     "Lahore, Punjab, Pakistan", "Kyiv, Kyiv City, Ukraine",
                     "Melbourne, Victoria, Australia"]) {
    assert.equal(locationAllowed(loc, latam), false, `foreign location admitted: ${loc}`);
  }
});

// ------------------------------------------------------------------- language facet
// The spoken-language requirement reuses the same spec + exact-match machinery. Its
// labels are LOCALIZED and its ladder has two neighbours one word apart, which is
// exactly where a "first match wins" picker would pick the wrong proficiency.
import { pickExactLabel } from "../runtime-strategies/recruiter.mjs";

test("proficiency pick: 'Nivel profesional avanzado' must not match 'Nivel profesional'", () => {
  const menu = ["Cualquiera", "Básico", "Competente", "Nivel profesional",
                "Nivel profesional avanzado", "Nativo o bilingüe"];
  assert.equal(pickExactLabel("Nivel profesional avanzado", menu), 4);
  assert.equal(pickExactLabel("Nivel profesional", menu), 3);
  // an English label on this Spanish menu matches nothing → the caller tries the next
  // spelling instead of clicking a wrong item
  assert.equal(pickExactLabel("Full Professional", menu), -1);
});

test("mode pick: the three facet modes are distinguished", () => {
  const menu = ["Puede tener", "Debe tener", "No es necesario que tenga"];
  assert.equal(pickExactLabel("Debe tener", menu), 1);
  assert.equal(pickExactLabel("Must have", menu), -1);   // → falls through to "Debe tener"
  assert.equal(pickExactLabel("Puede tener", menu), 0);
});

test("language spec: both spellings parse, blank means no facet", () => {
  assert.deepEqual(parseLocationSpec("Inglés|English"), [["Inglés", "English"]]);
  assert.deepEqual(parseLocationSpec("{{language}}"), []);
});
