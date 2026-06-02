// Type declarations for step-interpreter.mjs (plain JS so the Playwright daemon
// can import it without a build step; these declarations let the TypeScript
// extension consume the same runtime-agnostic step-interpretation logic).

export interface SelectorLike { type?: string; value?: string; score?: number }

export function orderSelectorChain<T extends SelectorLike>(chain: T[]): T[];

export function isDangerousXPath(xpath: string): boolean;

export function normalizeText(value: string): string;

export function normalizeForCheck(value: string): string;

export function parseAccessibility(data: string): { role: string; label: string };

export function parseShadowCss(raw: string): { hostChain: string[]; target: string } | null;

export function parseAnchor(value: string): {
  anchorSelector: string;
  offsetX: number;
  offsetY: number;
  relation: string;
} | null;

export interface SuccessConditionValues {
  pageText?: string;
  currentUrl?: string;
  inputValue?: string | null;
  selectorFound?: boolean;
}

export function evaluateSuccessCondition(
  condition: { type?: string; value?: string; selector?: string } | null | undefined,
  values?: SuccessConditionValues,
): { ok: boolean; reason?: string };

export function successConditionInputs(
  condition: { type?: string } | null | undefined,
): string[];
