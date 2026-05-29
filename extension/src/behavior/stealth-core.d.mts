// Type declarations for the runtime-agnostic behavior primitives in
// stealth-core.mjs (plain JS so the Playwright daemon can import it without a
// build step; these declarations let the TypeScript extension consume it).

export const LINKEDIN_DETAIL_SECTIONS: string[];

export function cryptoRandom(): number;

export function mulberry32(seed: number): () => number;

export function shuffleInPlace<T>(arr: T[], rand?: () => number): T[];

export function pickDwellMs(min: number, max: number, rand?: () => number): number;

export function bezierPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
  rand?: () => number,
): Array<{ x: number; y: number }>;
