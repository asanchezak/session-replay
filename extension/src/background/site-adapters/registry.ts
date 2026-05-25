import {
  getLinkedInProfileSnapshotTargets,
  LINKEDIN_SITE_HARNESS,
  recoverLinkedInMissingDependency,
  type SiteSnapshotTarget,
} from "./linkedin";
import type { SiteAdapterRuntime } from "./types";

export const SITE_ADAPTERS: Record<string, SiteAdapterRuntime> = {
  "site:linkedin": {
    harnessId: "site:linkedin",
    site: "linkedin",
    logPrefix: "linkedin-site",
    harness: LINKEDIN_SITE_HARNESS,
    recoverMissingDependency: recoverLinkedInMissingDependency,
  },
};

export function getSiteAdapterRuntime(harnessId: unknown): SiteAdapterRuntime | null {
  return typeof harnessId === "string" ? SITE_ADAPTERS[harnessId] ?? null : null;
}

export function getPageSnapshotTargets(url: string): SiteSnapshotTarget[] {
  return getLinkedInProfileSnapshotTargets(url);
}
