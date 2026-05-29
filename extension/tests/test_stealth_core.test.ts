import { describe, it, expect } from "vitest";
import {
  LINKEDIN_DETAIL_SECTIONS,
  cryptoRandom,
  mulberry32,
  shuffleInPlace,
  pickDwellMs,
  bezierPath,
} from "../src/behavior/stealth-core.mjs";

describe("stealth-core pure behavior primitives", () => {
  it("mulberry32 is deterministic per seed and varies across seeds", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    const seqC = [c(), c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of [...seqA, ...seqC]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("cryptoRandom returns a float in [0,1)", () => {
    for (let i = 0; i < 100; i++) {
      const v = cryptoRandom();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("shuffleInPlace is a permutation (no loss/dup) and seedable", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffleInPlace([...arr], mulberry32(7));
    expect([...out].sort((x, y) => x - y)).toEqual(arr);
    // Same seed → same shuffle.
    const a = shuffleInPlace([...arr], mulberry32(99));
    const b = shuffleInPlace([...arr], mulberry32(99));
    expect(a).toEqual(b);
  });

  it("pickDwellMs stays within [min,max]", () => {
    const rand = mulberry32(123);
    for (let i = 0; i < 500; i++) {
      const d = pickDwellMs(4000, 22000, rand);
      expect(d).toBeGreaterThanOrEqual(4000);
      expect(d).toBeLessThanOrEqual(22000);
    }
  });

  it("bezierPath returns `steps` points ending at the target", () => {
    const path = bezierPath({ x: 0, y: 0 }, { x: 200, y: 120 }, 6, mulberry32(5));
    expect(path).toHaveLength(6);
    const last = path[path.length - 1];
    expect(Math.abs(last.x - 200)).toBeLessThan(0.01);
    expect(Math.abs(last.y - 120)).toBeLessThan(0.01);
    // Two different seeds produce differently-shaped curves (not identical).
    const p2 = bezierPath({ x: 0, y: 0 }, { x: 200, y: 120 }, 6, mulberry32(6));
    expect(path).not.toEqual(p2);
  });

  it("LINKEDIN_DETAIL_SECTIONS lists the expected profile subpages", () => {
    expect(LINKEDIN_DETAIL_SECTIONS).toEqual([
      "experience",
      "education",
      "skills",
      "certifications",
      "projects",
      "languages",
    ]);
  });
});
