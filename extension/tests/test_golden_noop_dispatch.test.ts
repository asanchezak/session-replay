import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs module without types
import { PHASE_A_VERBS } from "../src/behavior/selector-resolve.mjs";

// GOLDEN NO-OP guard for Phase A.
//
// Phase A adds a `click`/`type` arm to the daemon dispatch loop. This is purely
// additive ONLY IF no current LinkedIn flow emits those verbs through the loop —
// otherwise the new branch would change behavior on the flagged anti-bot path.
//
// This is a cheap CLASSIFICATION guard, not a behavior test (the dispatch loop in
// driver-daemon.mjs is module-private and cannot be imported — importing the
// daemon starts its top-level poll loop). The real regression gate is the SSH E2E
// step-sequence/count diff. Here we only assert that the action_types the current
// lead + applicant flows ever feed the loop are disjoint from PHASE_A_VERBS.
//
// Source of truth for these sequences: driver-daemon.mjs dispatch arms (navigate,
// extract, noise_break, open_message_drafts) + the preamble (navigate/noise_break)
// + for_each expansion (navigate/extract/noise_break). No flow emits click/type.

const LEAD_RUN_ACTION_TYPES = [
  "navigate",      // step 0 feed warm-up
  "noise_break",   // step 1 idle noise
  "navigate",      // step 2 people search
  "navigate",      // step 3 scrape page 1 (reported as navigate-class extraction post)
  "navigate",      // step 4 page-2 nav
  "navigate",      // step 5 scrape page 2
];

const APPLICANT_RUN_ACTION_TYPES = [
  "navigate",          // step 0 feed warm-up
  "noise_break",       // step 1 idle noise
  "navigate",          // step 2 people search
  "navigate",          // step 3 scrape page 1
  "navigate",          // step 4 page-2 nav
  "navigate",          // step 5 scrape page 2
  "for_each",          // step 6 expansion trigger
  "navigate",          // per-iteration profile nav
  "extract",           // per-iteration profile scrape
  "noise_break",       // inter-iteration noise
  "open_message_drafts", // optional messaging step
];

describe("golden no-op: Phase A adds branches no current flow takes", () => {
  it("lead-run action_types never classify into the new click/type arm", () => {
    const offenders = LEAD_RUN_ACTION_TYPES.filter((a) => PHASE_A_VERBS.has(a));
    expect(offenders).toEqual([]);
  });

  it("applicant-run action_types never classify into the new click/type arm", () => {
    const offenders = APPLICANT_RUN_ACTION_TYPES.filter((a) => PHASE_A_VERBS.has(a));
    expect(offenders).toEqual([]);
  });

  it("negative control: the new arm DOES claim click + type, not navigate/extract", () => {
    expect(PHASE_A_VERBS.has("click")).toBe(true);
    expect(PHASE_A_VERBS.has("type")).toBe(true);
    expect(PHASE_A_VERBS.has("navigate")).toBe(false);
    expect(PHASE_A_VERBS.has("extract")).toBe(false);
    expect(PHASE_A_VERBS.has("noise_break")).toBe(false);
  });
});
