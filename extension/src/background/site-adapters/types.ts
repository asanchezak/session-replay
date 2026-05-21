export type SiteAdapterHarnessResult =
  | {
      ok: true;
      operation: string;
      action: "click" | "type" | "noop" | "navigate";
      x: number;
      y: number;
      width: number;
      height: number;
      tag: string;
      text: string;
      reason: string;
      insertText?: string;
      targetUrl?: string;
      settleMs?: number;
    }
  | {
      ok: false;
      operation: string;
      error: string;
      debug?: Record<string, unknown>;
    };

export type SiteAdapterHarness = (args: Record<string, unknown>) => SiteAdapterHarnessResult;

export type MissingDependencyRecovery = (
  operation: string,
  failed: Extract<SiteAdapterHarnessResult, { ok: false }>,
  args: Record<string, unknown>,
) => Record<string, unknown> | null;

export type SiteAdapterRuntime = {
  harnessId: string;
  site: string;
  logPrefix: string;
  harness: SiteAdapterHarness;
  recoverMissingDependency?: MissingDependencyRecovery;
};
