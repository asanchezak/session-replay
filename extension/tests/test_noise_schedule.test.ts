import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs module without types
import { mulberry32, pickNoiseScrollTicks, pickNoiseDwellMs } from "../src/behavior/stealth-core.mjs";

// SEED-EQUIVALENCE guard for the Phase B noise refactor.
//
// executeNoiseBreakDaemon's scroll-tick and dwell formulas were moved verbatim
// into pickNoiseScrollTicks / pickNoiseDwellMs. The anti-bot invariant is that
// the per-seed rand-draw sequence — and therefore every sleep/scroll duration —
// is BYTE-FOR-BYTE identical before and after. We encode the ORIGINAL inline
// formulas here as the reference and assert the extracted helpers reproduce them
// across many seeds, kinds, and the hasTarget branch, driving the SAME draw
// order the daemon uses: ticks-draw → humanScrollSeeded (3 draws/tick) → dwell-draw.

// --- Reference: the formulas EXACTLY as they were inline in driver-daemon.mjs ---
function originalTicks(kind: string, hasTarget: boolean, rand: () => number): number {
  switch (kind) {
    case "search_bounce": return hasTarget ? 2 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 3);
    case "feed_scroll": return 2 + Math.floor(rand() * 3);
    case "profile_hover": return hasTarget ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 3);
    default: return 2 + Math.floor(rand() * 3);
  }
}
function originalDwell(kind: string, hasTarget: boolean, rand: () => number): number {
  switch (kind) {
    case "search_bounce": return 5000 + Math.floor(rand() * 7000);
    case "feed_scroll": return 8000 + Math.floor(rand() * 12000);
    case "profile_hover": return hasTarget ? 3000 + Math.floor(rand() * 5000) : 5000 + Math.floor(rand() * 10000);
    default: return 5000 + Math.floor(rand() * 10000);
  }
}

// humanScrollSeeded (page-nav.mjs) consumes 3 rand draws per tick:
//   dy = (rand() > 0.3 ? 1 : -1) * (300 + floor(rand()*500))  // 2 draws
//   sleep(800 + floor(rand()*1700))                            // 1 draw
function advanceForScroll(ticks: number, rand: () => number): void {
  for (let i = 0; i < ticks; i++) { rand(); rand(); rand(); }
}

function runSequence(
  pickTicks: (k: string, h: boolean, r: () => number) => number,
  pickDwell: (k: string, h: boolean, r: () => number) => number,
  kind: string,
  hasTarget: boolean,
  seed: number,
): { ticks: number; dwell: number } {
  const rand = mulberry32(seed >>> 0);
  const ticks = pickTicks(kind, hasTarget, rand);
  advanceForScroll(ticks, rand); // humanScrollSeeded happens between the two draws
  const dwell = pickDwell(kind, hasTarget, rand);
  return { ticks, dwell };
}

const KINDS = ["search_bounce", "feed_scroll", "profile_hover", "idle_scroll"];
const SEEDS = [1, 2, 7, 42, 1337, 0xabcdef, 0xffffffff, 123456789];

describe("noise schedule seed-equivalence (byte-for-byte)", () => {
  for (const kind of KINDS) {
    for (const hasTarget of [true, false]) {
      it(`${kind} hasTarget=${hasTarget}: extracted helpers match the original formulas across seeds`, () => {
        for (const seed of SEEDS) {
          const original = runSequence(originalTicks, originalDwell, kind, hasTarget, seed);
          const extracted = runSequence(pickNoiseScrollTicks, pickNoiseDwellMs, kind, hasTarget, seed);
          expect(extracted).toEqual(original);
        }
      });
    }
  }

  it("sanity: helpers honor the per-kind ranges (catches a degenerate/constant helper)", () => {
    // Drive 500 seeds through each helper and assert the observed min/max fall in
    // the documented range. A helper that ignored kind/hasTarget would violate one.
    const sample = (fn: (k: string, h: boolean, r: () => number) => number, kind: string, h: boolean) => {
      let lo = Infinity, hi = -Infinity;
      for (let s = 1; s <= 500; s++) { const v = fn(kind, h, mulberry32(s)); lo = Math.min(lo, v); hi = Math.max(hi, v); }
      return { lo, hi };
    };
    expect(sample(pickNoiseScrollTicks, "search_bounce", true)).toMatchObject({ lo: 2 }); // 2 + [0,1]
    expect(sample(pickNoiseScrollTicks, "search_bounce", true).hi).toBeLessThanOrEqual(3);
    expect(sample(pickNoiseScrollTicks, "profile_hover", true).lo).toBe(1); // 1 + [0,1]
    expect(sample(pickNoiseDwellMs, "feed_scroll", false).lo).toBeGreaterThanOrEqual(8000);
    expect(sample(pickNoiseDwellMs, "feed_scroll", false).hi).toBeLessThan(20000);
    expect(sample(pickNoiseDwellMs, "profile_hover", true).hi).toBeLessThan(8000); // 3000 + [0,5000)
    expect(sample(pickNoiseDwellMs, "idle_scroll", false).hi).toBeGreaterThanOrEqual(8000); // 5000 + up to 10000
  });
});
