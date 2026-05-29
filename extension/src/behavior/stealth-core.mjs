/**
 * stealth-core — pure, runtime-agnostic behavior primitives shared by the
 * Chrome extension (service-worker.ts) and the standalone Playwright daemon
 * (driver-daemon.mjs).
 *
 * These functions contain NO `chrome.*` and NO Playwright `page` references —
 * only math + entropy. The two runtimes wrap them with their own I/O
 * (CDP `dispatchMouse*` in the extension, `page.mouse.*` in the daemon).
 *
 * Every function that consumes randomness accepts an optional `rand: () => number`
 * (uniform float in [0,1)). Callers that want determinism (replayable noise,
 * tests) pass a seeded `mulberry32(seed)`; callers that want true entropy omit
 * it and get `cryptoRandom`.
 */

// The /details/<section>/ subpages a LinkedIn profile exposes. Mirrors the
// list previously duplicated in site-adapters/linkedin.ts.
export const LINKEDIN_DETAIL_SECTIONS = [
  "experience",
  "education",
  "skills",
  "certifications",
  "projects",
  "languages",
];

// Uniform float in [0,1) from CSPRNG entropy. Works in both Node 19+ (global
// `crypto`) and the browser/service-worker (`crypto`).
export function cryptoRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 0x1_0000_0000;
}

// Tiny deterministic PRNG. Same seed → same sequence, so a profile/run can be
// replayed with an identical-but-non-mechanical behavior shape, and tests can
// assert exact outputs.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates, in place. `rand` defaults to CSPRNG entropy.
export function shuffleInPlace(arr, rand = cryptoRandom) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Beta-skewed dwell: biases toward shorter reads with an occasional long tail,
// which matches how people actually skim profile sections.
export function pickDwellMs(min, max, rand = cryptoRandom) {
  const r = rand() * rand() + rand() * 0.15;
  return Math.floor(min + (max - min) * Math.min(1, r));
}

// Cubic-bezier path between two points with two randomized control points, so
// successive mouse moves aren't identically shaped. Returns `steps` points
// (excluding the origin). `rand` defaults to CSPRNG entropy.
export function bezierPath(from, to, steps, rand = cryptoRandom) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const c1 = {
    x: from.x + dx * (0.25 + rand() * 0.2),
    y: from.y + dy * (0.25 + rand() * 0.2) + (rand() - 0.5) * 80,
  };
  const c2 = {
    x: from.x + dx * (0.6 + rand() * 0.2),
    y: from.y + dy * (0.6 + rand() * 0.2) + (rand() - 0.5) * 80,
  };
  const out = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const it = 1 - t;
    const x =
      it * it * it * from.x +
      3 * it * it * t * c1.x +
      3 * it * t * t * c2.x +
      t * t * t * to.x;
    const y =
      it * it * it * from.y +
      3 * it * it * t * c1.y +
      3 * it * t * t * c2.y +
      t * t * t * to.y;
    out.push({ x, y });
  }
  return out;
}
