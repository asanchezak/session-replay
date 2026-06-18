// Unit test for the per-stage success verdict (recruiter pipeline). Pure function,
// no seat/browser needed. Run: `node --test extension/tests/stage-verdict.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stageVerdict } from "../runtime-strategies/recruiter.mjs";

const v = (strategy, eventKind, extraction) => stageVerdict({ strategy, eventKind, extraction });

test("create_project: ok only when redirected to /talent/hire/<id>", () => {
  assert.equal(v("recruiter_search_people", "recruiter_create_project",
    { url: "https://www.linkedin.com/talent/hire/2063010290/discover/recruiterSearch", people: [] }).ok, true);
  // empty new project page is expected — must NOT gate on people
  assert.equal(v("recruiter_search_people", "recruiter_create_project",
    { url: "https://www.linkedin.com/talent/hire/999/manage/all", people: [] }).ok, true);
  const bad = v("recruiter_search_people", "recruiter_create_project",
    { url: "https://www.linkedin.com/talent/create/get-started", people: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "project_not_created");
});

test("search: rendered (count read, even 0) or people>0 passes; null+empty fails", () => {
  assert.equal(v("recruiter_search_people", "recruiter_search", { total_count: 7, people: [{}] }).ok, true);
  assert.equal(v("recruiter_search_people", "recruiter_search", { total_count: 0, people: [] }).ok, true); // legit 0-match
  assert.equal(v("recruiter_search_people", "recruiter_search", { total_count: null, people: [{}] }).ok, true);
  const bad = v("recruiter_search_people", "recruiter_search", { total_count: null, people: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "search_results_did_not_render");
});

test("search_people in other contexts (e.g. preview_count) is not gated", () => {
  assert.equal(v("recruiter_search_people", "recruiter_preview_count", { total_count: null, people: [] }).ok, true);
});

test("save: needs saved_count>0; null verify passes (flake-safe); affirmative 0 fails", () => {
  assert.equal(v("recruiter_save_results_to_project", "recruiter_save",
    { save_result: { saved_count: 2, verified_in_project: 5 } }).ok, true);
  assert.equal(v("recruiter_save_results_to_project", "recruiter_save",
    { save_result: { saved_count: 2, verified_in_project: null } }).ok, true); // flaked verify → trust save
  assert.equal(v("recruiter_save_results_to_project", "recruiter_save",
    { save_result: { saved_count: 2 } }).ok, true); // undefined verify → pass
  assert.equal(v("recruiter_save_results_to_project", "recruiter_save",
    { save_result: { saved_count: 0 } }).reason, "save_selected_none"); // run 4cf59660
  assert.equal(v("recruiter_save_results_to_project", "recruiter_save",
    { save_result: { saved_count: 3, verified_in_project: 0 } }).reason, "save_unverified_zero");
});

test("archive / archive_all / recommendations / add_profile gate on result.ok", () => {
  assert.equal(v("recruiter_archive_candidate", "recruiter_archive", { archive_result: { ok: true } }).ok, true);
  assert.equal(v("recruiter_archive_candidate", "recruiter_archive", { archive_result: { ok: false } }).ok, false);
  // archive_all: partial progress (more_remaining) co-exists with ok:true
  assert.equal(v("recruiter_archive_all_in_project", "recruiter_demo_archive",
    { archive_all_result: { ok: true, more_remaining: true } }).ok, true);
  assert.equal(v("recruiter_archive_all_in_project", "recruiter_demo_archive",
    { archive_all_result: { ok: false } }).ok, false);
  assert.equal(v("recruiter_save_recommendations", "recruiter_recommendations",
    { save_recommendations_result: { ok: true } }).ok, true);
  assert.equal(v("recruiter_save_recommendations", "recruiter_recommendations",
    { save_recommendations_result: { ok: false } }).ok, false);
  assert.equal(v("recruiter_add_profile", "recruiter_demo_add", { add_profile_result: { ok: true } }).ok, true);
  assert.equal(v("recruiter_add_profile", "recruiter_demo_add", { add_profile_result: { ok: false } }).ok, false);
});

test("message: gated preview & sent pass; blocked/rate-limited fail with reason", () => {
  assert.equal(v("recruiter_message_compose", "recruiter_message",
    { message_compose_result: { ok: true, sent: false, gated: true } }).ok, true);
  assert.equal(v("recruiter_message_compose", "recruiter_message",
    { message_compose_result: { ok: true, sent: true } }).ok, true);
  const blocked = v("recruiter_message_compose", "recruiter_message",
    { message_compose_result: { ok: false, blocked: true, reason: "rate_limited_24h" } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "rate_limited_24h");
});

test("read-only / probe / unknown strategies are never gated", () => {
  assert.equal(v("recruiter_read_project", "recruiter_read", { project_read: { ok: true } }).ok, true);
  assert.equal(v("recruiter_hot_reload_probe", undefined, {}).ok, true);
  assert.equal(v("recruiter_something_new", "recruiter_x", {}).ok, true);
});

test("missing args / empty extraction never throw", () => {
  assert.equal(stageVerdict().ok, true);
  assert.equal(stageVerdict({ strategy: "recruiter_save_results_to_project" }).reason, "save_selected_none");
});
