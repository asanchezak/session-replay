import { orchestrator, runTabMap, setRunTab, clearRunTab } from "./orchestrator";
import { apiClient } from "./api";
import { createLogger } from "../shared/logger";
import { stepHealer } from "./healer";
import { stepExecutor } from "./executor";
import { registerServiceWorkerListeners } from "./message-router";
import { commandExecutor, DebuggerSession } from "./command-executor";
import { waitForTabLoad, waitForTabLoadBestEffort } from "./tab-load";
import { openMessageComposerAndType } from "./openMessageComposerAndType";
import { getPageSnapshotTargets } from "./site-adapters/registry";
import { bezierPath, mulberry32, pickDwellMs, shuffleInPlace, cryptoRandom } from "../behavior/stealth-core.mjs";
import { detectChallenges } from "../shared/detector";
import type { ChallengeDetection } from "../shared/detector";
import type { BackgroundToContentMessage, DetectChallengesMessage, ChallengesDetectedResponse } from "../shared/messaging";
import type { AgentDecision, AgentCommand, PageContext } from "../shared/types";

const log = createLogger("service-worker");

// Configure side panel to open when the extension action button is clicked
// so the panel stays visible for the entire run instead of closing like a popup.
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

/** Run IDs that have been explicitly canceled by the user while the loop was still running. */
const canceledRuns = new Set<string>();

/** Send a SHOW_OVERLAY or HIDE_OVERLAY message to the content script in `tabId`. */
function sendOverlay(
  tabId: number,
  payload: { step: number; total: number; action_type: string; workflow_name: string } | null,
): void {
  const msg = payload
    ? { type: "SHOW_OVERLAY", ...payload }
    : { type: "HIDE_OVERLAY" };
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function reportStepFailure(runId: string, stepIndex: number, error: string, actionType?: string): Promise<void> {
  try {
    await apiClient.reportStepResult(runId, stepIndex, false, error, actionType);
  } catch (err) {
    log.error("Failed to report step failure, trying direct fail:", err);
    try {
      await apiClient.failRun(runId, error);
    } catch (err2) {
      log.error("Failed to fail run on backend:", err2);
    }
  }
}

async function executeStepOnTab(
  step: BackgroundToContentMessage["step"],
  tabId?: number,
): Promise<{ success: boolean; error?: string }> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTabId = tabId || tabs[0]?.id;
  if (!targetTabId) {
    return { success: false, error: "No active tab found" };
  }

  let lastError = "Content script not available on this page. Navigate to the target page first.";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
    }
    try {
      const response = await chrome.tabs.sendMessage(targetTabId, {
        type: "EXECUTE_STEP",
        step,
      } as BackgroundToContentMessage);
      return response as { success: boolean; error?: string };
    } catch (err) {
      lastError = "Content script not available on this page. Navigate to the target page first.";
    }
  }
  return { success: false, error: lastError };
}

async function detectChallengesOnTab(tabId: number): Promise<ChallengeDetection[]> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "DETECT_CHALLENGES",
      protocol_version: 1,
    } as DetectChallengesMessage);
    const data = response as ChallengesDetectedResponse;
    return (data.challenges || []) as ChallengeDetection[];
  } catch {
    return [];
  }
}

class AnalyzeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const RESTRICTED_URL_RE = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|about|view-source|file):/i;

function classifyTabForCapture(url: string | undefined): AnalyzeError | null {
  if (!url) return new AnalyzeError("NO_TAB", "No active tab to analyze.");
  if (RESTRICTED_URL_RE.test(url)) {
    return new AnalyzeError(
      "URL_BLOCKED",
      "This page is blocked by the browser. Open a regular http(s) page first.",
    );
  }
  return null;
}

type SavedPageSnapshot = {
  section_name: string;
  page_url: string;
  page_title?: string;
  visible_text: string;
  dom_snippet: string;
  captured_at: string;
};

const PRIORITY_SECTION_TEXT_LIMIT = 16_000;
const MAIN_SECTION_TEXT_LIMIT = 8_000;
const DEFAULT_SECTION_TEXT_LIMIT = 8_000;

function normalizeLinkedInSnapshotText(snapshot: SavedPageSnapshot): string {
  let text = (snapshot.visible_text || snapshot.dom_snippet || "").trim();
  if (!text) return "";

  const footerMarkers = [
    "\nQuestions?\n",
    "\nAbout\n\nAccessibility\n",
    "\nAbout\nAccessibility\n",
    "\nLinkedIn Corporation",
    "\nSelect language\n",
  ];
  const footerIndices = footerMarkers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  if (footerIndices.length > 0) {
    text = text.slice(0, footerIndices[0]).trim();
  }

  if (snapshot.section_name === "main_profile") {
    const aboutMarker = "\nAbout\n";
    const aboutIndex = text.indexOf(aboutMarker);
    if (aboutIndex >= 0) {
      text = text.slice(aboutIndex + 1);
      const aboutEndIndices = ["\nTop skills\n", "\nActivity\n", "\nExperience\n", "\nEducation\n"]
        .map((marker) => text.indexOf(marker))
        .filter((index) => index > 0)
        .sort((a, b) => a - b);
      if (aboutEndIndices.length > 0) {
        text = text.slice(0, aboutEndIndices[0]).trim();
      }
    }
    return text.trim();
  }

  const sectionLabels: Record<string, string> = {
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    certifications: "Certifications",
    projects: "Projects",
    languages: "Languages",
  };
  const label = sectionLabels[snapshot.section_name] || "";
  if (label) {
    const marker = `\n${label}\n`;
    const markerIndex = text.indexOf(marker);
    if (markerIndex >= 0) {
      text = text.slice(markerIndex + 1).trim();
    } else {
      const fallbackIndex = text.lastIndexOf(label);
      if (fallbackIndex >= 0) {
        text = text.slice(fallbackIndex).trim();
      }
    }
  }
  return text.trim();
}

function buildSnapshotSectionText(snapshot: SavedPageSnapshot, limit: number): string {
  const text = normalizeLinkedInSnapshotText(snapshot);
  if (!text) return "";
  return `## Section: ${snapshot.section_name}\nURL: ${snapshot.page_url}\n${text.slice(0, limit)}`;
}

function buildSnapshotPageContent(
  snapshots: SavedPageSnapshot[],
  preferredSections: string[] = [],
): string {
  const preferred = preferredSections.map((value) => value.trim().toLowerCase()).filter(Boolean);
  const preferredSnapshots: SavedPageSnapshot[] = [];
  const remainingSnapshots: SavedPageSnapshot[] = [];
  const seen = new Set<SavedPageSnapshot>();

  for (const sectionName of preferred) {
    const match = snapshots.find((snapshot) => snapshot.section_name.toLowerCase() === sectionName);
    if (match && !seen.has(match)) {
      preferredSnapshots.push(match);
      seen.add(match);
    }
  }

  const mainSnapshot = snapshots.find((snapshot) => snapshot.section_name === "main_profile");
  if (mainSnapshot) {
    seen.add(mainSnapshot);
  }

  for (const snapshot of snapshots) {
    if (!seen.has(snapshot) && snapshot.section_name !== "main_profile") {
      remainingSnapshots.push(snapshot);
      seen.add(snapshot);
    }
  }

  const parts: string[] = [];
  for (const snapshot of preferredSnapshots) {
    const sectionText = buildSnapshotSectionText(snapshot, PRIORITY_SECTION_TEXT_LIMIT);
    if (sectionText) parts.push(sectionText);
  }
  if (mainSnapshot) {
    const sectionText = buildSnapshotSectionText(mainSnapshot, MAIN_SECTION_TEXT_LIMIT);
    if (sectionText) parts.push(sectionText);
  }
  for (const snapshot of remainingSnapshots) {
    const sectionText = buildSnapshotSectionText(snapshot, DEFAULT_SECTION_TEXT_LIMIT);
    if (sectionText) parts.push(sectionText);
  }
  return parts.join("\n\n");
}

function readSavedPageSnapshots(step: {
  dom_context?: Record<string, unknown> | null;
}): SavedPageSnapshot[] {
  const domContext = step.dom_context;
  if (!domContext || typeof domContext !== "object") return [];
  const plural = domContext.page_snapshots;
  if (Array.isArray(plural)) {
    return plural.filter((entry): entry is SavedPageSnapshot => (
      !!entry
      && typeof entry === "object"
      && typeof (entry as SavedPageSnapshot).section_name === "string"
      && typeof (entry as SavedPageSnapshot).page_url === "string"
    ));
  }
  const singular = domContext.page_snapshot;
  if (singular && typeof singular === "object") {
    const entry = singular as Record<string, unknown>;
    return [{
      section_name: "main_profile",
      page_url: String(entry.page_url || ""),
      page_title: typeof entry.page_title === "string" ? entry.page_title : undefined,
      visible_text: String(entry.visible_text || ""),
      dom_snippet: String(entry.dom_snippet || ""),
      captured_at: typeof entry.captured_at === "string" ? entry.captured_at : new Date().toISOString(),
    }];
  }
  return [];
}

function maybeUseRecordedSnapshotContent(
  liveContent: string,
  currentUrl: string,
  step: { dom_context?: Record<string, unknown> | null },
  preferredSections: string[],
): string {
  const storedSnapshots = readSavedPageSnapshots(step);
  if (storedSnapshots.length === 0) return liveContent;
  const storedMainUrl = storedSnapshots[0]?.page_url || "";
  if (!storedMainUrl || storedMainUrl !== currentUrl) return liveContent;
  const storedContent = buildSnapshotPageContent(storedSnapshots, preferredSections);
  return storedContent || liveContent;
}

function chooseExtractionSnapshots(
  currentUrl: string,
  liveSnapshots: SavedPageSnapshot[],
  step: { dom_context?: Record<string, unknown> | null },
): SavedPageSnapshot[] {
  const storedSnapshots = readSavedPageSnapshots(step);
  const storedMainUrl = storedSnapshots[0]?.page_url || "";
  if (storedSnapshots.length > 0 && storedMainUrl === currentUrl) {
    return storedSnapshots;
  }
  return liveSnapshots;
}

function selectSnapshotsForField(
  fieldKey: string,
  snapshots: SavedPageSnapshot[],
): SavedPageSnapshot[] {
  const normalizedField = fieldKey.trim().toLowerCase();
  const exact = snapshots.filter((snapshot) => snapshot.section_name.toLowerCase() === normalizedField);
  if (exact.length > 0) return exact;

  const aliases: Record<string, string[]> = {
    about: ["main_profile"],
    experience: ["experience"],
    education: ["education"],
    skills: ["skills"],
    certifications: ["certifications"],
    languages: ["languages"],
    projects: ["projects"],
  };
  const matchNames = new Set(aliases[normalizedField] || []);
  const matched = snapshots.filter((snapshot) => matchNames.has(snapshot.section_name.toLowerCase()));
  if (matched.length > 0) return matched;

  const main = snapshots.find((snapshot) => snapshot.section_name === "main_profile");
  return main ? [main] : snapshots.slice(0, 1);
}

async function prepareTabForCapture(tabId: number): Promise<void> {
  const startedAt = Date.now();
  log.log("Analyze prepare start", { tab_id: tabId });
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PREPARE_FOR_CAPTURE" });
    log.log("Analyze prepare done", {
      tab_id: tabId,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch {
    // Best-effort only; capture still proceeds if the content script cannot scroll.
    log.warn("Analyze prepare skipped", {
      tab_id: tabId,
      elapsed_ms: Date.now() - startedAt,
    });
  }
}

async function fetchSupplementalSnapshots(
  tabId: number,
  pageUrl: string,
): Promise<SavedPageSnapshot[]> {
  const targets = getPageSnapshotTargets(pageUrl);
  if (targets.length === 0) return [];
  const startedAt = Date.now();
  log.log("Supplemental snapshot fetch start", {
    tab_id: tabId,
    page_url: pageUrl,
    target_sections: targets.map((target) => target.sectionName),
  });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [targets],
      func: async (snapshotTargets: Array<{ sectionName: string; pageUrl: string }>) => {
        const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();
        const normalizeDom = (doc: Document): string => {
          const cloned = doc.body?.cloneNode(true) as HTMLElement | null;
          if (!cloned) return "";
          cloned.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
          return cloned.innerHTML;
        };
        const snapshots = await Promise.all(snapshotTargets.map(async (target) => {
          try {
            const response = await fetch(target.pageUrl, { credentials: "include" });
            if (!response.ok) return null;
            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, "text/html");
            const visibleText = normalizeText(doc.body?.innerText || "");
            const domSnippet = normalizeDom(doc);
            if (!visibleText && !domSnippet) return null;
            return {
              section_name: target.sectionName,
              page_url: target.pageUrl,
              page_title: doc.title || undefined,
              visible_text: visibleText.slice(0, 60_000),
              dom_snippet: domSnippet.slice(0, 120_000),
              captured_at: new Date().toISOString(),
            };
          } catch {
            return null;
          }
        }));
        return snapshots.filter((snapshot): snapshot is {
          section_name: string;
          page_url: string;
          page_title: string | undefined;
          visible_text: string;
          dom_snippet: string;
          captured_at: string;
        } => snapshot !== null);
      },
    });
    const snapshots = (results[0]?.result as SavedPageSnapshot[] | undefined) || [];
    log.log("Supplemental snapshot fetch done", {
      tab_id: tabId,
      page_url: pageUrl,
      snapshot_count: snapshots.length,
      elapsed_ms: Date.now() - startedAt,
      sections: snapshots.map((snapshot) => snapshot.section_name),
    });
    return snapshots;
  } catch (err) {
    log.warn("Supplemental snapshot fetch failed", {
      tab_id: tabId,
      page_url: pageUrl,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function looksLikeClientShellSnapshot(snapshot: SavedPageSnapshot): boolean {
  const text = `${snapshot.visible_text || ""}\n${snapshot.dom_snippet || ""}`.toLowerCase();
  if (!text) return true;
  return (
    text.includes("(function cdnmonitor()") ||
    text.includes("localizedconfigassetpaths") ||
    text.includes("proto.sdui") ||
    text.includes("lixseed") ||
    text.includes("importmap") ||
    text.includes("bundlecdnurl")
  );
}

async function captureSnapshotFromIframe(
  tabId: number,
  targetUrl: string,
  sectionName: string,
): Promise<SavedPageSnapshot | null> {
  const startedAt = Date.now();
  log.log("Iframe snapshot start", {
    tab_id: tabId,
    section_name: sectionName,
    target_url: targetUrl,
  });
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [targetUrl, sectionName],
      func: async (iframeUrl: string, iframeSectionName: string) => {
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        const existing = document.getElementById("__sr_linkedin_snapshot_iframe");
        if (existing) existing.remove();

        const iframe = document.createElement("iframe");
        iframe.id = "__sr_linkedin_snapshot_iframe";
        iframe.src = iframeUrl;
        iframe.setAttribute("aria-hidden", "true");
        iframe.style.position = "fixed";
        iframe.style.left = "-10000px";
        iframe.style.top = "0";
        iframe.style.width = "1280px";
        iframe.style.height = "1600px";
        iframe.style.opacity = "0";
        iframe.style.pointerEvents = "none";
        document.body.appendChild(iframe);

        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error("iframe_load_timeout")), 20_000);
            iframe.onload = () => {
              window.clearTimeout(timeout);
              resolve();
            };
            iframe.onerror = () => {
              window.clearTimeout(timeout);
              reject(new Error("iframe_load_failed"));
            };
          });
          await sleep(4_000);
          const doc = iframe.contentDocument;
          const win = iframe.contentWindow;
          if (!doc || !win) return null;

          let stableTicks = 0;
          let lastScrollY = -1;
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            const viewport = Math.max(win.innerHeight || 0, 600);
            win.scrollBy(0, Math.max(Math.floor(viewport * 0.9), 400));
            await sleep(300);
            const currentScrollY = Math.round(win.scrollY || 0);
            if (currentScrollY === lastScrollY) {
              stableTicks += 1;
              if (stableTicks >= 2) break;
            } else {
              stableTicks = 0;
              lastScrollY = currentScrollY;
            }
          }
          await sleep(800);

          const visibleText = (doc.body?.innerText || "").slice(0, 60_000);
          const domSnippet = (doc.body?.innerHTML || "").slice(0, 120_000);
          if (!visibleText && !domSnippet) return null;
          return {
            section_name: iframeSectionName,
            page_url: win.location.href || iframeUrl,
            page_title: doc.title || undefined,
            visible_text: visibleText,
            dom_snippet: domSnippet,
            captured_at: new Date().toISOString(),
          };
        } finally {
          iframe.remove();
        }
      },
    });
    const snapshot = (results[0]?.result as SavedPageSnapshot | null | undefined) || null;
    log.log("Iframe snapshot done", {
      tab_id: tabId,
      section_name: sectionName,
      target_url: targetUrl,
      elapsed_ms: Date.now() - startedAt,
      found: !!snapshot,
      visible_text_length: snapshot?.visible_text.length || 0,
      dom_snippet_length: snapshot?.dom_snippet.length || 0,
    });
    return snapshot;
  } catch (err) {
    log.warn("Iframe detail snapshot failed", {
      tab_id: tabId,
      section_name: sectionName,
      target_url: targetUrl,
      elapsed_ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function isLinkedInProfilePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return false;
    return /^\/in\/[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

// cryptoRandom / shuffleInPlace / pickDwellMs / bezierPath / mulberry32 are now
// imported from ../behavior/stealth-core.mjs (shared with the Playwright daemon).

async function getShowAllSections(tabId: number, pageUrl: string): Promise<Set<string>> {
  // Inspect the current profile page for "Show all" links into /details/X/.
  // Real readers only click into sections that have substance; sections with
  // no Show-all link have their data already inline on the main page.
  try {
    const targets = getPageSnapshotTargets(pageUrl);
    if (targets.length === 0) return new Set();
    const sectionPaths = targets.map((t) => new URL(t.pageUrl).pathname);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [sectionPaths],
      func: (paths: string[]) => {
        const out: string[] = [];
        for (const path of paths) {
          const anchors = document.querySelectorAll(`a[href*="${path}"]`);
          if (anchors.length > 0) out.push(path);
        }
        return out;
      },
    });
    const found = (results?.[0]?.result as string[]) || [];
    return new Set(found);
  } catch {
    return new Set();
  }
}

async function microScroll(tabId: number, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [(cryptoRandom() > 0.3 ? 1 : -1) * (300 + Math.floor(cryptoRandom() * 500))],
        func: (dy: number) => window.scrollBy({ top: dy, behavior: "smooth" }),
      });
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800 + Math.floor(cryptoRandom() * 1700)));
  }
}

// Tracks last-known cursor position per tab so successive trusted clicks
// can dispatch a bezier-curve path from where the cursor "is" to the next
// target. Real users don't teleport — clicks always follow a mouse move.
const lastCursorByTab = new Map<number, { x: number; y: number }>();

// bezierPath imported from ../behavior/stealth-core.mjs.

async function locateSectionAnchor(
  tabId: number,
  sectionPath: string,
): Promise<{ x: number; y: number } | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [sectionPath],
      func: async (path: string) => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(`a[href*="${path}"]`),
        );
        const target = anchors.find((a) => {
          try {
            const u = new URL(a.href);
            return u.pathname.endsWith(path) || u.pathname.endsWith(path.replace(/\/$/, ""));
          } catch {
            return false;
          }
        });
        if (!target) return null;
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        await sleep(700);
        const r = target.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      },
    });
    return (results?.[0]?.result as { x: number; y: number } | null) || null;
  } catch (err) {
    log.warn("locateSectionAnchor failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function clickSectionLink(
  tabId: number,
  sectionPath: string,
): Promise<boolean> {
  const target = await locateSectionAnchor(tabId, sectionPath);
  if (!target) return false;
  // Initialise cursor to a randomized "innocent" spot near viewport center
  // on first interaction in this tab.
  let cursor = lastCursorByTab.get(tabId);
  if (!cursor) {
    cursor = {
      x: 600 + (cryptoRandom() - 0.5) * 300,
      y: 360 + (cryptoRandom() - 0.5) * 200,
    };
  }
  const steps = 3 + Math.floor(cryptoRandom() * 4); // 3-6 moves
  const path = bezierPath(cursor, target, steps);
  for (const p of path) {
    const ok = await DebuggerSession.dispatchMouseMove(tabId, p.x, p.y);
    if (!ok) return false;
    await new Promise((r) => setTimeout(r, 30 + Math.floor(cryptoRandom() * 60)));
  }
  // Tiny pause at the target before the click (humans don't click instantly
  // upon arrival).
  await new Promise((r) => setTimeout(r, 80 + Math.floor(cryptoRandom() * 140)));
  const clicked = await DebuggerSession.dispatchMouseClick(tabId, target.x, target.y);
  if (!clicked) return false;
  lastCursorByTab.set(tabId, target);
  return true;
}

// mulberry32 imported from ../behavior/stealth-core.mjs (shared with the daemon
// and the backend's seed contract).

// Track the most recent search URL the agent navigated to per tab. Used by
// `noise_break.search_bounce` so we can return to the user's search context
// instead of guessing a URL. Populated by any LinkedIn search navigation
// (agent EXECUTE path, fast-path for_each navigate, or even manual user
// navigation in the same tab).
const lastSearchUrlByTab = new Map<number, string>();
try {
  chrome.tabs?.onUpdated.addListener((tabId, _changeInfo, tab) => {
    const url = tab.url || "";
    if (/linkedin\.com\/search\/results\//.test(url)) {
      lastSearchUrlByTab.set(tabId, url);
    }
  });
} catch { /* MV2/test env fallback */ }

// Track URLs the workflow has already navigated to (for `profile_hover` to
// pick a decoy URL distinct from the next target).
const seenProfileUrlsByRun = new Map<string, string[]>();

// Per-tab "anti-bot" flag for the active run, sourced from the workflow's
// `config.anti_bot`. Set when a run starts (executeRun / executeAgentRun) once
// the target tab is known, and consulted by the humanization helpers
// (humanStepDelay, executeNoiseBreak, the LinkedIn detail capture) so they pace
// like a human ONLY when the workflow opted in. Opt-in: absent ⇒ false ⇒
// mechanical. Mirrors the tab-keyed maps above (e.g. lastSearchUrlByTab).
const antiBotByTab = new Map<number, boolean>();
function isAntiBot(tabId: number | undefined): boolean {
  return tabId != null && antiBotByTab.get(tabId) === true;
}

async function fetchProfileUrlPoolForRun(runId: string): Promise<string[]> {
  // Reuse cached pool if already populated this run.
  const cached = seenProfileUrlsByRun.get(runId);
  if (cached && cached.length > 0) return cached;
  try {
    const events = await apiClient.getRunEvents(runId, 200);
    const collected: string[] = [];
    for (const ev of events) {
      if (ev.event_type !== "extraction") continue;
      for (const rec of ev.payload?.data || []) {
        const urls = (rec as { profile_urls?: unknown }).profile_urls;
        if (Array.isArray(urls)) {
          for (const u of urls) if (typeof u === "string") collected.push(u);
        }
      }
    }
    seenProfileUrlsByRun.set(runId, collected);
    return collected;
  } catch {
    return [];
  }
}

async function microScrollSeeded(tabId: number, ticks: number, rand: () => number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        args: [(rand() > 0.3 ? 1 : -1) * (300 + Math.floor(rand() * 500))],
        func: (dy: number) => window.scrollBy({ top: dy, behavior: "smooth" }),
      });
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 800 + Math.floor(rand() * 1700)));
  }
}

// Generic inter-step pause, applied on EVERY page. When the workflow opted into
// anti-bot, replace the flat configured delay with a variable, beta-skewed dwell
// (human reading cadence) plus an occasional micro-scroll; otherwise keep the
// fast, mechanical flat delay.
async function humanStepDelay(tabId: number, flatMs: number): Promise<void> {
  if (!isAntiBot(tabId)) {
    await new Promise((r) => setTimeout(r, flatMs));
    return;
  }
  if (cryptoRandom() < 0.5) {
    await microScrollSeeded(tabId, 1 + Math.floor(cryptoRandom() * 2), cryptoRandom);
  }
  await new Promise((r) => setTimeout(r, pickDwellMs(1200, 6000)));
}

async function executeNoiseBreak(
  tabId: number,
  kind: string,
  seed: number,
  runId: string,
  originStep: number | undefined,
): Promise<void> {
  // noise_break is purely decoy behavior; when the workflow hasn't opted into
  // anti-bot, skip the decoy navigation + idle dwell entirely (caller still
  // reports the step a success). Opt-in default: absent config ⇒ mechanical.
  if (!isAntiBot(tabId)) return;
  const rand = mulberry32(seed);
  const safelyNavigate = async (url: string) => {
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId, 20_000).catch(() => undefined);
  };
  switch (kind) {
    case "search_bounce": {
      const searchUrl = lastSearchUrlByTab.get(tabId);
      if (!searchUrl) {
        // Nothing to bounce to — fall through to idle scrolling.
        await microScrollSeeded(tabId, 2 + Math.floor(rand() * 3), rand);
        await new Promise((r) => setTimeout(r, 5000 + Math.floor(rand() * 7000)));
        return;
      }
      await safelyNavigate(searchUrl);
      await microScrollSeeded(tabId, 2 + Math.floor(rand() * 2), rand);
      await new Promise((r) => setTimeout(r, 5000 + Math.floor(rand() * 7000)));
      return;
    }
    case "feed_scroll": {
      await safelyNavigate("https://www.linkedin.com/feed/");
      await microScrollSeeded(tabId, 2 + Math.floor(rand() * 3), rand);
      await new Promise((r) => setTimeout(r, 8000 + Math.floor(rand() * 12000)));
      return;
    }
    case "profile_hover": {
      const pool = await fetchProfileUrlPoolForRun(runId);
      // originStep is currently unused — retained on the noise step for
      // future per-source filtering if we ever need it.
      void originStep;
      const candidate = pool.length > 0 ? pool[Math.floor(rand() * pool.length)] : null;
      if (candidate) {
        await safelyNavigate(candidate);
        await microScrollSeeded(tabId, 1 + Math.floor(rand() * 2), rand);
        await new Promise((r) => setTimeout(r, 3000 + Math.floor(rand() * 5000)));
        return;
      }
      // Fallback to idle scroll if we couldn't get a decoy.
      await microScrollSeeded(tabId, 2 + Math.floor(rand() * 3), rand);
      await new Promise((r) => setTimeout(r, 5000 + Math.floor(rand() * 10000)));
      return;
    }
    case "idle_scroll":
    default: {
      await microScrollSeeded(tabId, 2 + Math.floor(rand() * 3), rand);
      await new Promise((r) => setTimeout(r, 5000 + Math.floor(rand() * 10000)));
      return;
    }
  }
}

async function captureLinkedInDetailsViaTabNavigation(
  tabId: number,
  pageUrl: string,
): Promise<SavedPageSnapshot[]> {
  // Anti-bot strategy:
  //   1. Same tab, no hidden background tabs.
  //   2. Inspect the current profile for which /details/ sections have
  //      "Show all" anchors — only visit those (real readers don't click
  //      into already-fully-inline sections).
  //   3. Probabilistic subset of the candidates (per-section p = 0.65),
  //      capped at max_sections_per_profile.
  //   4. Shuffle the visit order.
  //   5. Variable dwell (4-22 s, beta-skewed) with 1-3 micro-scrolls.
  const startedAt = Date.now();
  // Human reading dwells / pre-nav pauses only when the workflow opted into
  // anti-bot; otherwise capture each section back-to-back (still trusted clicks
  // + SPA render waits, just no idle "reading" time).
  const antiBot = isAntiBot(tabId);
  const allTargets = getPageSnapshotTargets(pageUrl);
  if (allTargets.length === 0) return [];

  const showAll = await getShowAllSections(tabId, pageUrl);
  const SECTION_VISIT_PROBABILITY = 0.65;
  const MAX_SECTIONS = 5;

  // Filter to sections that have a Show-all link, then probabilistically include.
  const candidates = allTargets.filter((t) => showAll.has(new URL(t.pageUrl).pathname));
  const included = candidates.filter(() => cryptoRandom() < SECTION_VISIT_PROBABILITY);
  // Guarantee at least one section if any are available, otherwise we'd
  // skip the profile entirely.
  if (included.length === 0 && candidates.length > 0) {
    included.push(candidates[Math.floor(cryptoRandom() * candidates.length)]);
  }
  // Cap and shuffle.
  shuffleInPlace(included);
  if (included.length > MAX_SECTIONS) included.length = MAX_SECTIONS;

  log.log("LinkedIn in-tab capture start", {
    tab_id: tabId,
    page_url: pageUrl,
    total_candidates: allTargets.length,
    show_all_present: candidates.length,
    visiting_count: included.length,
    visiting: included.map((t) => t.sectionName),
  });

  const snapshots: SavedPageSnapshot[] = [];
  for (let i = 0; i < included.length; i++) {
    const target = included[i];
    try {
      // Short jittered pre-navigation pause — looks like reading then clicking.
      await new Promise((resolve) =>
        setTimeout(resolve, antiBot ? 600 + Math.floor(cryptoRandom() * 1400) : 120));

      // Prefer a trusted CDP click on the section anchor. Falls back to
      // chrome.tabs.update if the link isn't located.
      const sectionPath = new URL(target.pageUrl).pathname;
      const clicked = await clickSectionLink(tabId, sectionPath);
      if (!clicked) {
        await chrome.tabs.update(tabId, { url: target.pageUrl });
      }
      await waitForTabLoad(tabId, 25_000).catch(() => undefined);
      // Let the SPA bundle fetch + render section content.
      await new Promise((resolve) =>
        setTimeout(resolve, 1500 + Math.floor(cryptoRandom() * 1500)));
      await prepareTabForCapture(tabId).catch(() => undefined);

      const ctx = await commandExecutor.captureContext(tabId);
      if (ctx.visible_text || ctx.dom_snippet) {
        snapshots.push({
          section_name: target.sectionName,
          page_url: target.pageUrl,
          page_title: ctx.title || undefined,
          visible_text: ctx.visible_text,
          dom_snippet: ctx.dom_snippet,
          captured_at: new Date().toISOString(),
        });
      }

      // Variable dwell with micro-scrolls — looks like a person reading. Only
      // when anti-bot is enabled; otherwise move straight to the next section.
      if (antiBot) {
        const dwell = pickDwellMs(4_000, 22_000);
        const scrollTicks = 1 + Math.floor(cryptoRandom() * 3);
        const scrollBudget = Math.min(dwell - 500, scrollTicks * 2500);
        const scrollPromise = microScroll(tabId, scrollTicks);
        const dwellRemain = Math.max(500, dwell - scrollBudget);
        await Promise.all([
          scrollPromise,
          new Promise<void>((r) => setTimeout(r, dwellRemain)),
        ]);
      }
    } catch (err) {
      log.warn("LinkedIn in-tab capture per-section failed", {
        section: target.sectionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.log("LinkedIn in-tab capture done", {
    tab_id: tabId,
    elapsed_ms: Date.now() - startedAt,
    captured_count: snapshots.length,
    sections: snapshots.map((s) => s.section_name),
    text_lengths: snapshots.map((s) => s.visible_text.length),
  });
  return snapshots;
}

async function resolveSupplementalSnapshots(
  tabId: number,
  pageUrl: string,
): Promise<SavedPageSnapshot[]> {
  // LinkedIn /in/{user}/ profile pages: bypass the broken fetch+iframe path
  // (X-Frame-Options: DENY) by driving the same tab through each /details/X/.
  // This avoids hidden-tab fingerprinting that LinkedIn's anti-bot picks up.
  if (isLinkedInProfilePage(pageUrl)) {
    try {
      const captured = await captureLinkedInDetailsViaTabNavigation(tabId, pageUrl);
      if (captured.length > 0) return captured;
    } catch (err) {
      log.warn("LinkedIn in-tab capture errored — falling back to legacy path", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const startedAt = Date.now();
  const fetched = await fetchSupplementalSnapshots(tabId, pageUrl);
  const targets = getPageSnapshotTargets(pageUrl);
  const bySection = new Map(fetched.map((snapshot) => [snapshot.section_name, snapshot]));
  const resolved: SavedPageSnapshot[] = [];

  for (const target of targets) {
    const existing = bySection.get(target.sectionName);
    if (existing && !looksLikeClientShellSnapshot(existing)) {
      resolved.push(existing);
      continue;
    }
    const rendered = await captureSnapshotFromIframe(tabId, target.pageUrl, target.sectionName);
    if (rendered && !looksLikeClientShellSnapshot(rendered)) {
      resolved.push(rendered);
      continue;
    }
    if (existing) {
      resolved.push(existing);
    }
  }

  log.log("Supplemental snapshot resolution done", {
    tab_id: tabId,
    page_url: pageUrl,
    fetched_count: fetched.length,
    resolved_count: resolved.length,
    elapsed_ms: Date.now() - startedAt,
    sections: resolved.map((snapshot) => snapshot.section_name),
  });
  return resolved;
}

async function captureExpandedPageData(tabId: number, tabInfo: chrome.tabs.Tab): Promise<{
  captured: { visible_text: string; dom_snippet: string; title: string; url: string };
  pageSnapshots: SavedPageSnapshot[];
  buildPageContent: (preferredSections?: string[]) => string;
}> {
  const startedAt = Date.now();
  log.log("Expanded page capture start", {
    tab_id: tabId,
    tab_url: tabInfo.url || "",
    tab_status: tabInfo.status || "unknown",
  });
  await prepareTabForCapture(tabId);

  let captured: { visible_text: string; dom_snippet: string; title: string; url: string } | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const attemptStartedAt = Date.now();
    const ctx = await commandExecutor.captureContext(tabId);
    if (ctx.visible_text || ctx.dom_snippet) {
      captured = {
        visible_text: ctx.visible_text,
        dom_snippet: ctx.dom_snippet || "",
        title: ctx.title || tabInfo.title || "",
        url: ctx.url || tabInfo.url || "",
      };
      log.log("Main page capture done", {
        tab_id: tabId,
        attempt: attempt + 1,
        elapsed_ms: Date.now() - attemptStartedAt,
        visible_text_length: captured.visible_text.length,
        dom_snippet_length: captured.dom_snippet.length,
        page_url: captured.url,
      });
      break;
    }
    log.warn("Main page capture empty", {
      tab_id: tabId,
      attempt: attempt + 1,
      elapsed_ms: Date.now() - attemptStartedAt,
    });
    await new Promise((r) => setTimeout(r, 700));
  }

  if (!captured) {
    throw new AnalyzeError("EMPTY_PAGE", "Could not read page content.");
  }

  const pageSnapshots: SavedPageSnapshot[] = [{
    section_name: "main_profile",
    page_url: captured.url,
    page_title: captured.title || undefined,
    visible_text: captured.visible_text,
    dom_snippet: captured.dom_snippet,
    captured_at: new Date().toISOString(),
  }];
  pageSnapshots.push(...await resolveSupplementalSnapshots(tabId, captured.url));

  log.log("Expanded page capture done", {
    tab_id: tabId,
    page_url: captured.url,
    total_elapsed_ms: Date.now() - startedAt,
    snapshot_count: pageSnapshots.length,
    snapshot_sections: pageSnapshots.map((snapshot) => snapshot.section_name),
  });

  return {
    captured,
    pageSnapshots,
    buildPageContent: (preferredSections: string[] = []) => buildSnapshotPageContent(pageSnapshots, preferredSections),
  };
}

async function analyzeLivePage(tabId?: number): Promise<{
  page_url: string;
  page_title?: string;
  visible_text: string;
  dom_snippet: string;
  page_snapshots: SavedPageSnapshot[];
  suggested_fields: Array<{
    key: string;
    label: string;
    description?: string;
    shape?: { kind: "scalar" | "string_list" | "record_list" | "unknown"; item_keys: string[] | null };
  }>;
}> {
  const startedAt = Date.now();
  let resolvedTabId = tabId;
  if (!resolvedTabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    resolvedTabId = active?.id;
  }
  if (!resolvedTabId) throw new AnalyzeError("NO_TAB", "No active tab to analyze.");
  log.log("Analyze live page start", {
    requested_tab_id: tabId ?? null,
    resolved_tab_id: resolvedTabId,
  });

  let tabInfo: chrome.tabs.Tab | undefined;
  try {
    tabInfo = await chrome.tabs.get(resolvedTabId);
  } catch {
    throw new AnalyzeError("NO_TAB", "Active tab was closed.");
  }

  const urlError = classifyTabForCapture(tabInfo.url);
  if (urlError) throw urlError;

  // Wait for load if Chrome reports the tab is still loading.
  if (tabInfo.status !== "complete") {
    try {
      await waitForTabLoad(resolvedTabId, 15000);
      log.log("Analyze waited for tab load", {
        tab_id: resolvedTabId,
        page_url: tabInfo.url || "",
      });
    } catch {
      // best-effort
      log.warn("Analyze tab load wait timed out", {
        tab_id: resolvedTabId,
        page_url: tabInfo.url || "",
      });
    }
  }

  let expanded: Awaited<ReturnType<typeof captureExpandedPageData>> | null = null;
  try {
    expanded = await captureExpandedPageData(resolvedTabId, tabInfo);
  } catch (err) {
    try {
      const latest = await chrome.tabs.get(resolvedTabId);
      if (latest.status === "loading") {
        throw new AnalyzeError(
          "TIMEOUT",
          "The page hasn't finished loading. Wait for it to settle and try again.",
        );
      }
      throw err;
    } catch (nested) {
      if (nested instanceof AnalyzeError) throw nested;
      throw new AnalyzeError(
        "EMPTY_PAGE",
        "The page rendered but has no readable content yet. If it's an auth wall, log in and retry.",
      );
    }
  }
  const { captured, pageSnapshots } = expanded;

  const suggestionStartedAt = Date.now();
  const response = await apiClient.analyzePageSuggestions({
    page_url: captured.url,
    page_title: captured.title,
    visible_text: captured.visible_text,
    dom_snippet: captured.dom_snippet,
    page_snapshots: pageSnapshots,
  });
  log.log("Analyze suggestions done", {
    tab_id: resolvedTabId,
    page_url: captured.url,
    elapsed_ms: Date.now() - suggestionStartedAt,
    suggested_field_count: response.suggested_fields.length,
  });
  log.log("Analyze live page done", {
    tab_id: resolvedTabId,
    page_url: captured.url,
    total_elapsed_ms: Date.now() - startedAt,
    snapshot_count: pageSnapshots.length,
  });

  return {
    page_url: captured.url,
    page_title: captured.title,
    visible_text: captured.visible_text,
    dom_snippet: captured.dom_snippet,
    page_snapshots: pageSnapshots,
    suggested_fields: response.suggested_fields,
  };
}

async function analyzePageStep(
  workflowId: string,
  stepIndex: number,
  pageUrl: string,
  tabId?: number,
): Promise<{
  workflow_id: string;
  step_index: number;
  page_url: string;
  page_title?: string;
  suggested_fields: Array<{ key: string; label: string; description?: string }>;
}> {
  // Strategy: try every reasonable way to get page content before failing.
  //   1. Use a matching open tab if one exists.
  //   2. Otherwise open the page URL in a new tab.
  //   3. Either way, wait for load, then retry capture a few times — the
  //      content script may not have attached yet on a freshly-loaded tab.
  let targetTabId = tabId;
  let openedNewTab = false;

  if (!targetTabId) {
    const tabs = await chrome.tabs.query({});
    targetTabId = tabs.find((tab) => (tab.url || "").includes(pageUrl))?.id;
  }

  if (!targetTabId) {
    const created = await chrome.tabs.create({ url: pageUrl, active: false });
    targetTabId = created.id;
    openedNewTab = true;
  }

  if (!targetTabId) {
    throw new Error("Could not open or find a tab for the recorded page URL");
  }

  if (openedNewTab) {
    try {
      await waitForTabLoad(targetTabId, 20000);
    } catch {
      // Best-effort: even if load times out, the DOM may still be usable.
    }
  }

  const captureWithRetry = async (): Promise<{
    visible_text: string;
    dom_snippet: string;
    title: string;
  } | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ctx = await commandExecutor.captureContext(targetTabId!);
      if (ctx.visible_text || ctx.dom_snippet) {
        return {
          visible_text: ctx.visible_text,
          dom_snippet: ctx.dom_snippet || "",
          title: ctx.title || "",
        };
      }
      // Wait a beat for content script to attach / page to settle.
      await new Promise((r) => setTimeout(r, 800));
    }
    return null;
  };

  const captured = await captureWithRetry();
  if (!captured) {
    throw new Error(
      "Could not capture page content. Make sure the page is open and fully loaded, "
        + "and that you're logged in if it requires authentication.",
    );
  }

  return apiClient.analyzePageFields(workflowId, stepIndex, {
    page_url: pageUrl,
    page_title: captured.title || undefined,
    visible_text: captured.visible_text,
    dom_snippet: captured.dom_snippet || undefined,
  });
}

function parseExtractFields(value: string): string[] {
  return value
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

function normalizeFieldKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface FieldShapeHint {
  key: string;
  label?: string;
  kind?: "scalar" | "string_list" | "record_list" | "unknown";
  item_keys?: string[] | null;
}

function buildExtractSchema(
  fields: string[],
  shapes: FieldShapeHint[] = [],
): Record<string, unknown> {
  const shapeByKey = new Map<string, FieldShapeHint>();
  for (const s of shapes) shapeByKey.set(normalizeFieldKey(s.key || s.label || ""), s);

  const properties: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    const key = normalizeFieldKey(f);
    const shape = shapeByKey.get(key);
    properties[key] = {
      type: "string",
      ...(shape
        ? {
            shape: {
              kind: shape.kind ?? "unknown",
              item_keys: shape.item_keys ?? null,
            },
          }
        : {}),
    };
  }
  return { items: { properties }, properties };
}

function readShapesFromStep(
  step: { methods?: unknown },
): FieldShapeHint[] {
  if (!Array.isArray(step.methods)) return [];
  for (const entry of step.methods) {
    if (
      entry
      && typeof entry === "object"
      && (entry as Record<string, unknown>).kind === "extract_shapes"
      && Array.isArray((entry as Record<string, unknown>).shapes)
    ) {
      return (entry as { shapes: FieldShapeHint[] }).shapes;
    }
  }
  return [];
}

async function collectDomAnchors(
  tabId: number,
  pattern: string,
  max: number,
): Promise<{ urls: string[]; scrollTicks: number; anchorsSeen: number }> {
  // Function injected into the page MAIN world. Must be self-contained (no
  // closures over outer scope) because chrome.scripting serializes it.
  const collector = async (urlPattern: string, maxResults: number) => {
    const collect = (): string[] => {
      const out = new Set<string>();
      const anchors = document.querySelectorAll('a[href*="/in/"], a[href*="/company/"], a[href*="/jobs/"]');
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i] as HTMLAnchorElement;
        let href: string;
        try { href = a.href; } catch { continue; }
        if (!href) continue;
        let u: URL;
        try { u = new URL(href); } catch { continue; }
        if (urlPattern === "linkedin_profile") {
          if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) continue;
          const m = u.pathname.match(/^\/in\/([^/]+)(\/[a-z]{2}(-[a-zA-Z]{2,4})?\/?)?\/?$/i);
          if (!m) continue;
          const slug = m[1];
          if (!slug || slug.toLowerCase() === "me") continue;
          out.add(`https://www.linkedin.com/in/${slug}/`);
        }
      }
      return Array.from(out);
    };
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const deadline = Date.now() + 22_000;
    let urls = collect();
    let lastCount = urls.length;
    let stableTicks = 0;
    let scrollTicks = 0;
    while (Date.now() < deadline) {
      window.scrollBy(0, Math.max(window.innerHeight || 800, 600));
      scrollTicks++;
      await sleep(900);
      urls = collect();
      if (urls.length === lastCount) {
        stableTicks++;
        if (stableTicks >= 3 && urls.length >= 5) break;
        if (stableTicks >= 8) break;
      } else {
        stableTicks = 0;
        lastCount = urls.length;
      }
    }
    window.scrollTo(0, 0);
    return {
      urls: urls.slice(0, maxResults),
      scrollTicks,
      anchorsSeen: document.querySelectorAll('a[href*="/in/"]').length,
    };
  };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: collector,
    args: [pattern, max],
  });
  const out = results?.[0]?.result;
  if (out && typeof out === "object") {
    return {
      urls: Array.isArray((out as { urls?: unknown }).urls) ? (out as { urls: string[] }).urls : [],
      scrollTicks: typeof (out as { scrollTicks?: number }).scrollTicks === "number" ? (out as { scrollTicks: number }).scrollTicks : 0,
      anchorsSeen: typeof (out as { anchorsSeen?: number }).anchorsSeen === "number" ? (out as { anchorsSeen: number }).anchorsSeen : 0,
    };
  }
  return { urls: [], scrollTicks: 0, anchorsSeen: 0 };
}

async function executeExtractStep(
  runId: string,
  stepIndex: number,
  step: {
    action_type: string;
    value?: string;
    intent?: string;
    dom_context?: Record<string, unknown> | null;
    methods?: unknown;
  },
  targetTabId: number,
): Promise<void> {
  const stepValue = String(step.value || "").trim();
  const looksLikeSelectedParagraph =
    stepValue.length >= 80 &&
    /\s/.test(stepValue) &&
    /[.,;:]/.test(stepValue);

  if (looksLikeSelectedParagraph) {
    const directData = [{ selected_text: stepValue }];
    const directSchema = { properties: { selected_text: { type: "string" } } };
    await apiClient.reportExtraction(runId, stepIndex, directData, directSchema);
    log.log(`[Extract] Step ${stepIndex}: recorded direct selected_text (${stepValue.length} chars)`);
    await apiClient.reportStepResult(runId, stepIndex, true, undefined, "extract");
    return;
  }

  const selectedText = String((step.dom_context && step.dom_context["selected_text"]) || "").trim();
  const fields = parseExtractFields(step.value || "");
  if (fields.length === 0) {
    if (selectedText) {
      const fallbackData = [{ selected_text: selectedText }];
      const fallbackSchema = { properties: { selected_text: { type: "string" } } };
      await apiClient.reportExtraction(runId, stepIndex, fallbackData, fallbackSchema);
      log.log(`[Extract] Step ${stepIndex}: recorded selected text fallback (${selectedText.length} chars)`);
    } else {
      log.log(`[Extract] Step ${stepIndex}: no fields specified, skipping`);
    }
    await apiClient.reportStepResult(runId, stepIndex, true, undefined, "extract");
    return;
  }

  const shapes = readShapesFromStep(step);
  const schema = buildExtractSchema(fields, shapes);
  log.log(`[Extract] Step ${stepIndex}: fields=${fields.join(",")} shapes=${shapes.length}`);

  // Declarative DOM-anchor extraction takes precedence: when methods include
  // {kind:"extract_dom_anchors", field, url_pattern}, scroll the page and
  // collect matching anchor hrefs via a hard-coded chrome.scripting func
  // (avoids new Function()/eval which LinkedIn's CSP blocks in MAIN world).
  const scriptResults: Record<string, unknown> = {};
  const scriptHandledFields = new Set<string>();
  if (Array.isArray(step.methods)) {
    for (const m of step.methods as Array<Record<string, unknown>>) {
      if (!m || typeof m !== "object") continue;
      if (m.kind !== "extract_dom_anchors") continue;
      const field = String(m.field || "");
      const urlPattern = String(m.url_pattern || "");
      const max = typeof m.max === "number" ? m.max : 30;
      if (!field || !urlPattern) continue;
      const fieldKey = normalizeFieldKey(field);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const out = await collectDomAnchors(targetTabId, urlPattern, max);
        scriptResults[fieldKey] = out.urls;
        scriptHandledFields.add(fieldKey);
        log.log(`[Extract] Step ${stepIndex}: extract_dom_anchors ${field} (${urlPattern}) -> ${out.urls.length} urls, scrollTicks=${out.scrollTicks}, anchorsSeen=${out.anchorsSeen}`);
      } catch (err) {
        log.error(`[Extract] Step ${stepIndex}: extract_dom_anchors ${field} threw:`, err);
      }
    }
  }

  const remainingFields = fields.filter(
    (f) => !scriptHandledFields.has(normalizeFieldKey(f)),
  );

  // If every requested field was satisfied by a script, skip the AI/heuristic
  // path and report directly.
  if (remainingFields.length === 0 && scriptHandledFields.size > 0) {
    const tabInfo = await chrome.tabs.get(targetTabId).catch(() => undefined);
    const directData = [{
      page_title: tabInfo?.title || "",
      url: tabInfo?.url || "",
      ...scriptResults,
    }];
    await apiClient.reportExtraction(runId, stepIndex, directData, schema);
    await apiClient.reportStepResult(runId, stepIndex, true, undefined, "extract");
    log.log(`[Extract] Step ${stepIndex}: all fields satisfied by extract_script(s)`);
    return;
  }

  // For shape-aware extracts (Analyze Page → Apply) the heuristic DOM scraper
  // can't produce nested records, so we go AI-first. For legacy comma-list
  // extracts without shapes we still try the heuristic first and fall back.
  const aiFirst = shapes.length > 0;

  let data: Record<string, unknown>[] = [];
  let usedSchema: Record<string, unknown> = schema;

  if (aiFirst) {
    try {
      const tabInfo = await chrome.tabs.get(targetTabId);
      const { captured, pageSnapshots, buildPageContent } = await captureExpandedPageData(targetTabId, tabInfo);
      const chosenSnapshots = chooseExtractionSnapshots(captured.url, pageSnapshots, step);
      // Parallelize the per-field AI calls — they're independent, and at
      // ~3 s each going serial costs 18 s+ for a 6-field profile extract.
      const aiEntries = await Promise.all(remainingFields.map(async (field) => {
        const fieldKey = normalizeFieldKey(field);
        const fieldSchema = buildExtractSchema([field], shapes.filter((shape) => normalizeFieldKey(shape.key || shape.label || "") === fieldKey));
        const fieldContent = buildSnapshotPageContent(selectSnapshotsForField(field, chosenSnapshots), [field]);
        const fallbackContent = maybeUseRecordedSnapshotContent(
          buildPageContent([field]),
          captured.url,
          step,
          [field],
        );
        const pageText = fieldContent || fallbackContent || captured.visible_text || captured.dom_snippet || "";
        if (!pageText) return null;
        try {
          const aiResult = await apiClient.aiExtract(pageText, fieldSchema);
          const fieldData = aiResult.data as Record<string, unknown>;
          if (fieldData && typeof fieldData === "object" && !Array.isArray(fieldData) && fieldKey in fieldData) {
            return [fieldKey, fieldData[fieldKey]] as const;
          }
        } catch (err) {
          log.warn(`[Extract] Step ${stepIndex}: AI extract for field ${field} failed:`, err);
        }
        return null;
      }));
      const aiData: Record<string, unknown> = {};
      for (const entry of aiEntries) {
        if (entry) aiData[entry[0]] = entry[1];
      }
      const merged = { ...scriptResults, ...aiData };
      if (Object.keys(merged).length > 0) {
        data = [{
          page_title: captured.title || "",
          url: captured.url || "",
          ...merged,
        }];
        log.log(`[Extract] Step ${stepIndex}: extracted ${Object.keys(merged).length} field(s) (${Object.keys(scriptResults).length} script, ${Object.keys(aiData).length} AI)`);
      }
    } catch (err) {
      log.error(`[Extract] Step ${stepIndex}: AI-first extract failed:`, err);
    }
  } else {
    const extraction = await stepExecutor.extractData(
      targetTabId,
      schema,
      stepIndex,
    );
    data = extraction?.data || [];
    usedSchema = (extraction?.schema as Record<string, unknown> | null) || schema;
    const missingFields = extraction?.missing_fields || [];

    if (missingFields.length > 0 && data.length > 0) {
      log.log(
        `[Extract] Step ${stepIndex}: ${missingFields.length} field(s) missing (${missingFields.join(", ")}), trying AI`,
      );
      try {
        const tabInfo = await chrome.tabs.get(targetTabId);
        const { captured, pageSnapshots, buildPageContent } = await captureExpandedPageData(targetTabId, tabInfo);
        const chosenSnapshots = chooseExtractionSnapshots(captured.url, pageSnapshots, step);
        const aiData: Record<string, unknown> = {};
        for (const field of missingFields) {
          const fieldKey = normalizeFieldKey(field);
          const fieldContent = buildSnapshotPageContent(selectSnapshotsForField(field, chosenSnapshots), [field]);
          const fallbackContent = maybeUseRecordedSnapshotContent(
            buildPageContent([field]),
            captured.url,
            step,
            [field],
          );
          const pageText = fieldContent || fallbackContent || captured.visible_text || captured.dom_snippet || "";
          if (!pageText) continue;
          const missingSchema: Record<string, unknown> = {
            properties: { [fieldKey]: { type: "string" } },
          };
          const aiResult = await apiClient.aiExtract(pageText, missingSchema);
          const fieldResult = aiResult.data as Record<string, unknown>;
          if (fieldResult && typeof fieldResult === "object" && !Array.isArray(fieldResult) && fieldKey in fieldResult) {
            aiData[fieldKey] = fieldResult[fieldKey];
          }
        }
        if (aiData && typeof aiData === "object" && !Array.isArray(aiData)) {
          for (const [key, val] of Object.entries(aiData)) {
            if (val != null && !(key in data[0])) {
              data[0][key] = val;
            }
          }
          log.log(`[Extract] Step ${stepIndex}: AI filled ${Object.keys(aiData).length} field(s)`);
        }
      } catch (err) {
        log.error(`[Extract] Step ${stepIndex}: AI fallback failed:`, err);
      }
    }
  }

  if (data.length > 0) {
    await apiClient.reportExtraction(
      runId,
      stepIndex,
      data,
      usedSchema,
    );
    log.log(`[Extract] Step ${stepIndex}: recorded ${data.length} record(s)`);
  } else {
    if (selectedText) {
      const fallbackData = [{ selected_text: selectedText }];
      const fallbackSchema = { properties: { selected_text: { type: "string" } } };
      await apiClient.reportExtraction(runId, stepIndex, fallbackData, fallbackSchema);
      log.log(`[Extract] Step ${stepIndex}: no structured data; used selected text fallback`);
    } else {
      log.log(`[Extract] Step ${stepIndex}: no data extracted`);
    }
  }

  await apiClient.reportStepResult(runId, stepIndex, true, undefined, "extract");
}

async function extractAndReportRunData(
  workflowId: string,
  runId: string,
  tabId: number,
  stepIndex: number,
): Promise<void> {
  try {
    let outputSchema: Record<string, unknown> | null = null;
    try {
      const analysis = await apiClient.getWorkflowAnalysis(workflowId);
      const schema = analysis.output_spec?.schema;
      if (schema && typeof schema === "object") {
        outputSchema = schema as Record<string, unknown>;
      }
    } catch {
      // Analysis is optional; extraction can still fallback to page text.
    }

    const extraction = await stepExecutor.extractData(
      tabId,
      outputSchema,
      stepIndex,
    );
    if (extraction && extraction.data.length > 0) {
      await apiClient.reportExtraction(
        runId,
        extraction.step_index,
        extraction.data,
        extraction.schema,
      );
      log.log(`[Extraction] Recorded ${extraction.data.length} rows for run ${runId}`);
    } else {
      log.log(`[Extraction] No data extracted for run ${runId}`);
    }
  } catch (err) {
    log.error("[Extraction] Failed:", err);
  }
}

async function executeWorkflowRun(
  workflowId: string,
  tabId?: number,
): Promise<{ id: string; status: string; total_steps: number }> {
  const run = await apiClient.runWorkflow(workflowId);
  const runId = run.id;
  log.log(`Run ${runId} created for workflow ${workflowId}`);

  const workflow = await apiClient.getWorkflow(workflowId);
  const steps = workflow.steps || [];
  log.log(`Executing ${steps.length} steps for ${workflow.name}`);

  orchestrator.notifyRunning(workflow.name, 0, steps.length, runId);

  // Read configurable step delay from storage
  const { stepDelay = 1000 } = await chrome.storage.session.get("stepDelay");

  // Pin the target tab — resolve once, use throughout
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (!targetTabId) {
    return { id: runId, status: "failed", total_steps: steps.length };
  }
  await setRunTab(runId, targetTabId);
  // Opt-in anti-bot pacing for this run (governs humanStepDelay + the noise /
  // LinkedIn-capture dwells via isAntiBot). Absent config ⇒ false ⇒ mechanical.
  antiBotByTab.set(targetTabId, workflow.config?.anti_bot === true);
  sendOverlay(targetTabId, { step: 0, total: steps.length, action_type: "starting", workflow_name: workflow.name });

  // Navigate to target URL if set
  if (workflow.target_url) {
    try {
      await chrome.tabs.update(targetTabId, { url: workflow.target_url });
      log.log(`Navigated to target URL: ${workflow.target_url}`);
      await waitForTabLoad(targetTabId);
    } catch (err) {
      log.error("Failed to navigate to target URL:", err);
    }
  }

  let pendingNavigation = false;
  let allStepsSucceeded = true;
  let statusOverride: string | null = null;

  for (let i = 0; i < steps.length && allStepsSucceeded; i++) {
    if (canceledRuns.has(runId)) {
      canceledRuns.delete(runId);
      statusOverride = "canceled";
      break;
    }

    const step = steps[i];
    const actionType = step.action_type;
    log.log(`Executing step ${i + 1}/${steps.length}: ${actionType}`);

    orchestrator.notifyRunning(workflow.name, i, steps.length, runId);
    sendOverlay(targetTabId, { step: i, total: steps.length, action_type: actionType, workflow_name: workflow.name });

    // Pre-step: wait if previous step caused navigation
    if (pendingNavigation) {
      try {
        await waitForTabLoad(targetTabId);
      } catch (err) {
        log.error("Page did not load after navigation:", err);
        await reportStepFailure(runId, i, "Page load failed", actionType);
        allStepsSucceeded = false;
        break;
      }
      pendingNavigation = false;
    }

    // Verify tab still exists
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      log.error("Target tab was closed during execution");
      await reportStepFailure(runId, i, "Target tab was closed", actionType);
      allStepsSucceeded = false;
      break;
    }

    // Challenge detection before step execution
    const challenges = await detectChallengesOnTab(targetTabId);
    if (challenges.length > 0) {
      const c = challenges[0];
      log.log(`Challenge detected: ${c.type} - ${c.description}`);
      try {
        await apiClient.pauseRun(runId, c.description || `${c.type} challenge`, i);
      } catch (err) {
        log.error("Failed to pause run for challenge:", err);
      }
      orchestrator.notifyWaiting(runId, c.description || `${c.type} challenge`);
      sendOverlay(targetTabId, null);
      allStepsSucceeded = false;
      statusOverride = "waiting_for_user";
      break;
    }

    // Record before URL for navigation detection
    let beforeUrl: string | undefined;
    try {
      beforeUrl = (await chrome.tabs.get(targetTabId)).url;
    } catch {
      beforeUrl = undefined;
    }

    // For navigate steps, pre-register the load listener to avoid race
    let navPromise: Promise<void> | null = null;
    if (actionType === "navigate") {
      navPromise = waitForTabLoad(targetTabId);
    }

    // Extract steps: parse value into a field schema, run heuristic extraction
    // on the current page, then report results directly — no DOM manipulation.
    if (actionType === "extract") {
      await executeExtractStep(runId, i, step, targetTabId);
      await humanStepDelay(targetTabId, stepDelay);
      continue;
    }

    const stepToExecute: BackgroundToContentMessage["step"] = {
      action_type: actionType,
      selector_chain: step.selector_chain || [],
      value: step.value,
      intent: step.intent,
      success_condition: (step as unknown as Record<string, unknown>).success_condition as Record<string, unknown> | null | undefined,
      methods: (step as unknown as Record<string, unknown>).methods as BackgroundToContentMessage["step"]["methods"],
    };

    const result = await executeStepOnTab(stepToExecute, targetTabId);

    // URL comparison for navigation detection
    let urlChanged = false;
    try {
      const afterUrl = (await chrome.tabs.get(targetTabId)).url;
      if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
        urlChanged = true;
      }
    } catch {
      urlChanged = true;
    }

    // SPA URL change detection: poll for pushState-based navigation
    if (!urlChanged && beforeUrl) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const afterUrl = (await chrome.tabs.get(targetTabId)).url;
        if (beforeUrl !== afterUrl) {
          urlChanged = true;
        }
      } catch {
        // ignore polling failures
      }
    }

    // Failure analysis
    if (actionType === "navigate") {
      // Navigate steps: failure only means invalid URL
      if (!result.success) {
        log.error(`Navigate step ${i + 1} failed: ${result.error}`);
        await reportStepFailure(runId, i, result.error || "Navigate failed", actionType);
        orchestrator.notifyFailed(workflow.name, i, steps.length, runId, result.error || "Navigate failed");
        sendOverlay(targetTabId, null);
        allStepsSucceeded = false;
        break;
      }
      // Navigate always causes navigation — wait for load then check actual URL
      if (navPromise) {
        try { await navPromise; } catch { /* ignore load timeout */ }
      }
      log.log(`Step ${i + 1} (navigate) completed`);

      // Detect navigate mismatch: expected hostname vs actual hostname
      let pageContextError: string | undefined;
      let actualUrl: string | undefined;
      try {
        const tab = await chrome.tabs.get(targetTabId);
        actualUrl = tab.url;
        if (step.value && actualUrl) {
          const expectedHost = new URL(step.value).hostname;
          const actualHost = new URL(actualUrl).hostname;
          if (expectedHost !== actualHost) {
            pageContextError = "navigate_mismatch";
            log.log(`Navigate mismatch: expected ${expectedHost}, got ${actualHost}`);
          }
        }
      } catch { /* ignore URL parse errors */ }

      try {
        await apiClient.reportStepResult(runId, i, true, undefined, actionType, pageContextError, actualUrl);
      } catch (err) {
        log.error("Failed to confirm navigate step:", err);
      }
    } else if (!result.success) {
      // Non-navigate step failed — check if caused navigation
      if (urlChanged) {
        // Click caused navigation — treat as success
        log.log(`Step ${i + 1} caused navigation, considered successful`);
      } else {
        // Real failure — try healing before giving up
        log.error(`Step ${i + 1} failed: ${result.error}`);
        const healResult = await stepHealer.heal(runId, i, stepToExecute, targetTabId, workflow.name, steps.length);
        if (healResult.success) {
          log.log(`Step ${i + 1} healed successfully`);
          // 1. Transition RECOVERING→RUNNING via heal-result endpoint
          try {
            await apiClient.reportHealResult(runId, i, true, undefined, healResult.newSelectors);
          } catch (err) {
            log.error("Failed to report heal result:", err);
          }
          // 2. Now in RUNNING state — report step success (advance_step works)
          try {
            await apiClient.reportStepResult(runId, i, true, undefined, actionType);
          } catch (err) {
            log.error("Failed to report healed step:", err);
          }
        } else {
          // Heal failed — transition to WAITING_FOR_USER, not FAILED
          try {
            await apiClient.reportHealResult(runId, i, false, healResult.error || "Healing failed");
          } catch (err) {
            log.error("Failed to report heal failure, falling back:", err);
            await reportStepFailure(runId, i, healResult.error || result.error || "Step failed", actionType);
          }
          orchestrator.notifyFailed(workflow.name, i, steps.length, runId, healResult.error || result.error || "Step failed");
          sendOverlay(targetTabId, null);
          allStepsSucceeded = false;
          break;
        }
      }
    } else {
      // Step succeeded normally
      log.log(`Step ${i + 1} succeeded`);
      try {
        await apiClient.reportStepResult(runId, i, true, undefined, actionType);
      } catch (err) {
        log.error("Failed to confirm step on backend:", err);
        await reportStepFailure(runId, i, "Failed to confirm step execution", actionType);
        orchestrator.notifyFailed(workflow.name, i, steps.length, runId, "Failed to confirm step execution");
        sendOverlay(targetTabId, null);
        allStepsSucceeded = false;
        break;
      }
    }

    // Wait for navigation to settle
    if (actionType === "navigate" || urlChanged) {
      if (navPromise) {
        try {
          await navPromise;
        } catch {
          log.error("Page did not load after navigation");
        }
      }
      pendingNavigation = true;
    }

    // Delay between steps — humanized variable dwell when anti-bot is on.
    await humanStepDelay(targetTabId, stepDelay);
  }

  // Final navigation wait for last step
  if (pendingNavigation && allStepsSucceeded) {
    try {
      await waitForTabLoad(targetTabId);
    } catch {
      log.error("Final navigation load incomplete");
    }
  }

  if (allStepsSucceeded && statusOverride !== "canceled") {
    try {
      await apiClient.completeRun(runId);
      log.log(`Run ${runId} completed`);
    } catch (err) {
      log.error("Failed to complete run:", err);
    }

    // Attempt data extraction after successful run — skip if workflow already
    // has per-step extract actions (they've already reported extraction events).
    const hasExtractSteps = steps.some((s) => s.action_type === "extract");
    if (targetTabId && !hasExtractSteps) {
      await extractAndReportRunData(workflowId, runId, targetTabId, steps.length);
    }
  }

  if (targetTabId) sendOverlay(targetTabId, null);
  if (statusOverride !== "waiting_for_user" && statusOverride !== "canceled") {
    orchestrator.notifyIdle();
    orchestrator.broadcastState();
  }

  await clearRunTab(runId);
  if (targetTabId) antiBotByTab.delete(targetTabId);
  canceledRuns.delete(runId);
  return { id: runId, status: statusOverride || (allStepsSucceeded ? "completed" : "failed"), total_steps: steps.length };
}

async function executeAgentRun(
  workflowId: string,
  tabId?: number,
  goal?: string,
  runtimeParams?: Record<string, unknown>,
  onStart?: (runHandle: { id: string; status: string; total_steps: number }) => void,
): Promise<{ id: string; status: string; total_steps: number }> {
  const run = await apiClient.runWithParams(workflowId, runtimeParams || {}, goal);
  const runId = run.id;
  log.log(`[Agent] Run ${runId} started for workflow ${workflowId}`);
  // Workstream D follow-up: notify the caller as soon as the run is created
  // (before the loop runs to completion) so the dashboard bridge can post
  // RUN_STARTED without waiting for the entire workflow to finish.
  if (onStart) {
    try {
      onStart({ id: runId, status: run.status || "running", total_steps: run.total_steps || 0 });
    } catch (err) {
      log.error("[Agent] onStart callback threw:", err);
    }
  }

  const workflow = await apiClient.getWorkflow(workflowId);
  const plannedSteps = run.execution_plan?.steps;
  // Mutable, loosely-typed steps array so plan_updates can INSERT/REMOVE/MODIFY
  // arbitrary shapes mid-run. We rely on the backend snapshot as the source of
  // truth for execution; this local cache only feeds the HEAL fallback.
  const stepsSource = Array.isArray(plannedSteps) && plannedSteps.length > 0
    ? plannedSteps
    : (workflow.steps || []);
  const steps: Array<Record<string, unknown>> = stepsSource.map(
    (s) => ({ ...(s as unknown as Record<string, unknown>) }),
  );
  const totalSteps = steps.length;
  log.log(`[Agent] Executing ${totalSteps} steps for ${workflow.name}`);

  orchestrator.notifyRunning(workflow.name, 0, totalSteps, runId);

  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (!targetTabId) {
    log.error("[Agent] No target tab found");
    await apiClient.failRun(runId, "No target tab found");
    return { id: runId, status: "failed", total_steps: totalSteps };
  }
  await setRunTab(runId, targetTabId);
  // Opt-in anti-bot pacing for this run (governs the noise / LinkedIn-capture
  // dwells via isAntiBot). Absent config ⇒ false ⇒ mechanical.
  antiBotByTab.set(targetTabId, workflow.config?.anti_bot === true);
  sendOverlay(targetTabId, { step: 0, total: totalSteps, action_type: "starting", workflow_name: workflow.name });

  // Phase 2: fresh run = fresh diff history. Clear the per-tab snapshot
  // cache so the first poll doesn't show a "diff" against another run.
  commandExecutor.clearTabCache(targetTabId);

  if (workflow.target_url) {
    try {
      await chrome.tabs.update(targetTabId, { url: workflow.target_url });
      await waitForTabLoad(targetTabId);
    } catch (err) {
      log.error("[Agent] Failed to navigate to target URL:", err);
    }
  }

  const FATAL_ERROR_PREFIXES = ["SCRIPT_PARSE_ERROR"];
  const isFatalError = (err: string | null | undefined): boolean =>
    !!err && FATAL_ERROR_PREFIXES.some((p) => err.startsWith(p));

  let currentStepIndex = 0;
  let pollCount = 0;
  let finalStatus = "running"; // "running" = in-progress; set to terminal value to exit loop
  // Phase 3: when the backend says PAUSE, don't bail immediately — re-poll
  // for up to `pauseRePollCap * 10s` ≈ 5 minutes so the auto-recovery
  // supervisor can produce a fresh decision. After the cap, surface
  // waiting_for_user.
  let pausePollCount = 0;
  const pauseRePollCap = 30;

  // Vision (Workstream B): hybrid capture cadence. Track the previous decision
  // and last step result so we can decide when a screenshot adds signal.
  let lastDecision: string | null = null;
  let lastResultSuccess: boolean | null = null;
  const VISION_BASELINE_EVERY_N = 5;

  try {
  while (true) {
    pollCount++;

    // If the user canceled the run from the side panel while we were mid-loop,
    // exit cleanly without attempting any further API calls.
    if (canceledRuns.has(runId)) {
      canceledRuns.delete(runId);
      finalStatus = "canceled";
      break;
    }

    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      log.error("[Agent] Target tab closed");
      await apiClient.failRun(runId, "Target tab closed");
      orchestrator.notifyFailed(workflow.name, currentStepIndex, totalSteps, runId, "Target tab closed");
      sendOverlay(targetTabId, null);
      finalStatus = "failed";
      break;
    }

    const pageContext = await commandExecutor.captureContext(targetTabId);

    // unexpected_modal fires whenever role=dialog is visible — the EXPECTED state
    // when a workflow step opens a form dialog (e.g. Liquidación). Only hard-stop
    // for blockers the agent genuinely cannot handle (captcha, login form).
    if (pageContext.is_blocking && pageContext.blocking_type !== "unexpected_modal") {
      log.log(`[Agent] Blocking challenge: ${pageContext.blocking_type}`);
      await apiClient.pauseRun(runId, `Blocking: ${pageContext.blocking_type}`, currentStepIndex);
      orchestrator.notifyWaiting(runId, `Blocking: ${pageContext.blocking_type}`);
      sendOverlay(targetTabId, null);
      finalStatus = "waiting_for_user";
      break;
    }

    // Strip unexpected_modal from the context we send to the backend so it
    // doesn't also return PAUSE — the agent should fill in-workflow dialogs.
    const contextForPoll = pageContext.blocking_type === "unexpected_modal"
      ? { ...pageContext, is_blocking: false, blocking_type: null }
      : pageContext;

    // Extract steps are deterministic — execute them inline without an AI poll.
    const currentStep = steps[currentStepIndex] as
      | { action_type?: string; value?: string; intent?: string; methods?: unknown; dom_context?: Record<string, unknown> | null; _for_each_item?: string; delay_before_ms?: number; _noise_kind?: string; _noise_seed?: number; _for_each_origin_step?: number }
      | undefined;

    // noise_break pseudo-steps — anti-bot noise injected between for_each
    // iterations (or statically authored as pre-warm steps). Run silently
    // without an AI poll and report success.
    if (currentStep && currentStep.action_type === "noise_break") {
      try {
        if (currentStep.delay_before_ms && currentStep.delay_before_ms > 0) {
          log.log(`[Agent] noise_break delay: ${currentStep.delay_before_ms}ms`);
          await new Promise((r) => setTimeout(r, currentStep.delay_before_ms));
        }
        // for_each-expanded noise carries kind/seed as top-level fields;
        // static pre-warm noise carries them inside a noise_config method.
        let kind = currentStep._noise_kind;
        let seed: number | undefined =
          typeof currentStep._noise_seed === "number" ? currentStep._noise_seed : undefined;
        if (!kind && Array.isArray(currentStep.methods)) {
          for (const m of currentStep.methods as Array<Record<string, unknown>>) {
            if (m && typeof m === "object" && m.kind === "noise_config") {
              if (typeof m._noise_kind === "string") kind = m._noise_kind as string;
              if (typeof m._noise_seed === "number") seed = m._noise_seed as number;
            }
          }
        }
        const resolvedKind = String(kind || "idle_scroll");
        const resolvedSeed = typeof seed === "number" ? seed : Date.now();
        log.log(`[Agent] noise_break kind=${resolvedKind} seed=${resolvedSeed}`);
        await executeNoiseBreak(targetTabId, resolvedKind, resolvedSeed, runId, currentStep._for_each_origin_step);
        await apiClient.reportStepResult(runId, currentStepIndex, true, undefined, "noise_break");
      } catch (err) {
        log.warn("[Agent] noise_break failed (continuing):", err);
        try {
          await apiClient.reportStepResult(runId, currentStepIndex, true, undefined, "noise_break");
        } catch { /* ignore */ }
      }
      currentStepIndex++;
      if (currentStepIndex >= steps.length) {
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }
      continue;
    }

    // open_message_drafts — terminal step on outreach workflows.
    // Fetches the per-candidate targets from the backend and opens a new
    // tab per profile. We intentionally stop there: no compose UI is
    // triggered and nothing is typed or sent.
    if (currentStep && currentStep.action_type === "open_message_drafts") {
      let pacingMs = 1500;
      if (Array.isArray(currentStep.methods)) {
        for (const m of currentStep.methods as Array<Record<string, unknown>>) {
          if (m && typeof m.pacing_ms === "number") pacingMs = m.pacing_ms as number;
        }
      }
      const outcomes: Array<{ profile_url: string; ok: boolean; reason?: string }> = [];
      try {
        const payload = await apiClient.fetchMessageTargets(runId);
        const targets = payload?.targets || [];
        log.log(`[Agent] open_message_drafts: opening ${targets.length} candidate profile tab(s)`);
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          try {
            const tab = await chrome.tabs.create({ url: t.profile_url, active: false });
            if (!tab.id) {
              outcomes.push({ profile_url: t.profile_url, ok: false, reason: "tab_create_failed" });
              continue;
            }
            await waitForTabLoadBestEffort(tab.id, "open_message_drafts", 30000);
            outcomes.push({
              profile_url: t.profile_url,
              ok: true,
            });
            // Activate the last tab so the demo lands on a visible profile.
            if (i === targets.length - 1) {
              await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
            }
          } catch (err) {
            outcomes.push({
              profile_url: t.profile_url,
              ok: false,
              reason: String(err),
            });
          }
          if (i < targets.length - 1 && pacingMs > 0) {
            await new Promise((r) => setTimeout(r, pacingMs));
          }
        }
        log.log("[Agent] open_message_drafts outcomes:", outcomes);
        await apiClient.reportStepResult(
          runId,
          currentStepIndex,
          true,
          undefined,
          "open_message_drafts",
        );
      } catch (err) {
        log.error("[Agent] open_message_drafts failed:", err);
        await apiClient.reportStepResult(
          runId,
          currentStepIndex,
          false,
          String(err),
          "open_message_drafts",
        );
      }
      currentStepIndex++;
      if (currentStepIndex >= steps.length) {
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }
      continue;
    }

    // Fast-path: for_each-expanded navigate steps have a known $item URL —
    // skip the ~5-10 s AI poll and just navigate directly. Massively cuts
    // total time on multi-profile workflows (count=15 saves ~3-5 minutes).
    if (
      currentStep
      && currentStep.action_type === "navigate"
      && currentStep._for_each_item
      && typeof currentStep.value === "string"
      && /^https?:\/\//.test(currentStep.value)
    ) {
      const targetUrl = currentStep.value;
      try {
        if (currentStep.delay_before_ms && currentStep.delay_before_ms > 0) {
          await new Promise((r) => setTimeout(r, currentStep.delay_before_ms));
        }
        log.log(`[Agent] fast-path navigate (for_each) to ${targetUrl}`);
        await chrome.tabs.update(targetTabId, { url: targetUrl });
        // Remember the search URL if this navigate is to a LinkedIn search
        // results page — noise_break.search_bounce will return to it.
        if (/linkedin\.com\/search\/results\//.test(targetUrl)) {
          lastSearchUrlByTab.set(targetTabId, targetUrl);
        }
        await waitForTabLoad(targetTabId, 20_000).catch(() => undefined);
        await apiClient.reportStepResult(runId, currentStepIndex, true, undefined, "navigate", undefined, targetUrl);
      } catch (err) {
        log.error("[Agent] fast-path navigate failed:", err);
        await reportStepFailure(runId, currentStepIndex, "Navigate failed", "navigate");
        finalStatus = "failed";
        break;
      }
      currentStepIndex++;
      if (currentStepIndex >= steps.length) {
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }
      continue;
    }

    if (currentStep && currentStep.action_type === "extract") {
      log.log(`[Agent] Extract step ${currentStepIndex}: executing inline`);
      await executeExtractStep(
        runId,
        currentStepIndex,
        {
          action_type: "extract",
          value: currentStep.value,
          intent: currentStep.intent,
          methods: currentStep.methods,
          dom_context: currentStep.dom_context ?? null,
        },
        targetTabId,
      );
      currentStepIndex++;
      if (currentStepIndex >= steps.length) {
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }
      continue;
    }

    // for_each steps materialize their inner iteration sequence by asking the
    // backend to read prior extracted URLs from event_log, splice N copies of
    // inner_steps with $item substituted, and return the updated snapshot.
    if (currentStep && currentStep.action_type === "for_each") {
      log.log(`[Agent] for_each step ${currentStepIndex}: expanding`);
      try {
        const result = await apiClient.expandForEach(runId, currentStepIndex);
        const newSteps = Array.isArray(result.steps) ? result.steps : [];
        // Replace local steps with the materialized snapshot.
        steps.length = 0;
        for (const s of newSteps) steps.push(s as Record<string, unknown>);
        const iterations = typeof result.iterations === "number" ? result.iterations : 0;
        log.log(`[Agent] for_each expanded into ${iterations} iteration(s); total steps now ${steps.length}`);
        orchestrator.notifyRunning(workflow.name, currentStepIndex, steps.length, runId);
        // Tell the backend the for_each step is done so its current_step_index
        // advances past it; otherwise subsequent inner-step results trip the
        // STEP_INDEX_MISMATCH guard.
        try {
          await apiClient.reportStepResult(runId, currentStepIndex, true, undefined, "for_each");
        } catch (err) {
          log.warn("[Agent] reportStepResult for for_each failed:", err);
        }
      } catch (err) {
        log.error("[Agent] for_each expansion failed:", err);
        await apiClient.failRun(runId, "for_each expansion failed");
        finalStatus = "failed";
        break;
      }
      currentStepIndex++;
      if (currentStepIndex >= steps.length) {
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }
      continue;
    }

    // Hybrid vision policy: capture and attach a screenshot when the AI is
    // most likely to need pixels — first poll, after a recovery decision,
    // after a failure, on URL change, on visible blocker, or every Nth poll
    // as a safety baseline. On other polls send text-only to keep cost down.
    let visionTrigger: string | null = null;
    if (pollCount === 1) {
      visionTrigger = "first_poll";
    } else if (lastDecision === "ADAPT" || lastDecision === "RESTART"
      || lastDecision === "ROLLBACK" || lastDecision === "PAUSE") {
      visionTrigger = `post_${lastDecision.toLowerCase()}`;
    } else if (lastResultSuccess === false) {
      visionTrigger = "post_failure";
    } else if (pageContext.page_diff?.url_changed) {
      visionTrigger = "url_changed";
    } else if (pageContext.is_blocking
      && (pageContext.blocking_type === "unexpected_modal"
        || pageContext.blocking_type === "consent_banner")) {
      visionTrigger = "blocking_modal";
    } else if (pollCount % VISION_BASELINE_EVERY_N === 0) {
      visionTrigger = "baseline";
    }

    let screenshotPayload: { b64: string; mime: string; trigger: string } | null = null;
    if (visionTrigger) {
      const shot = await commandExecutor.captureScreenshot(targetTabId);
      if (shot) {
        screenshotPayload = { b64: shot.b64, mime: shot.mime, trigger: visionTrigger };
        log.log(`[Agent] Vision: ${visionTrigger} (${shot.width}x${shot.height}, ${shot.byte_size}B)`);
      }
    }

    log.log(`[Agent] Poll #${pollCount} step ${currentStepIndex}/${totalSteps}`);
    const pollResponse = await apiClient.agentPoll(runId, {
      page_context: contextForPoll,
      current_step_index: currentStepIndex,
      ...(screenshotPayload && {
        screenshot_b64: screenshotPayload.b64,
        screenshot_mime: screenshotPayload.mime,
        screenshot_trigger: screenshotPayload.trigger,
      }),
    });

    log.log(
      `[Agent] Decision: ${pollResponse.decision} ` +
      `(conf: ${pollResponse.confidence})`,
    );
    lastDecision = pollResponse.decision;

    if (pollResponse.decision !== "PAUSE") {
      pausePollCount = 0;
    }

    // Apply any plan_updates the backend issued before we act on the decision.
    // The backend has already mutated the run snapshot; mirror the same
    // mutation locally so currentStepIndex / steps stay aligned.
    const planUpdates = (pollResponse as unknown as { plan_updates?: Array<{ operation: string; step_index: number; new_step?: Record<string, unknown>; reason?: string }> }).plan_updates;
    if (planUpdates && planUpdates.length > 0) {
      log.log(`[Agent] Applying ${planUpdates.length} plan_update(s)`);
      for (const op of planUpdates) {
        const idx = op.step_index;
        switch (op.operation) {
          case "MODIFY":
          case "SIMPLIFY":
            if (idx >= 0 && idx < steps.length) {
              steps[idx] = { ...steps[idx], ...(op.new_step as Record<string, unknown>) };
            }
            break;
          case "INSERT":
          case "ADD": {
            const insertAt = Math.max(0, Math.min(idx, steps.length));
            steps.splice(insertAt, 0, { step_index: insertAt, ...(op.new_step || {}) });
            steps.forEach((s, i) => { (s as Record<string, unknown>).step_index = i; });
            if (currentStepIndex >= insertAt) currentStepIndex++;
            break;
          }
          case "REMOVE":
          case "SKIP":
            if (idx >= 0 && idx < steps.length) {
              steps.splice(idx, 1);
              steps.forEach((s, i) => { (s as Record<string, unknown>).step_index = i; });
              if (currentStepIndex > idx) currentStepIndex--;
            }
            break;
          case "REORDER": {
            const swapWith = (op.new_step as Record<string, unknown> | undefined)?.swap_with as number | undefined;
            if (swapWith !== undefined && idx >= 0 && idx < steps.length && swapWith >= 0 && swapWith < steps.length && idx !== swapWith) {
              [steps[idx], steps[swapWith]] = [steps[swapWith], steps[idx]];
              steps.forEach((s, i) => { (s as Record<string, unknown>).step_index = i; });
            }
            break;
          }
          default:
            log.log(`[Agent] Unknown plan_update op: ${op.operation}`);
        }
      }
    }

    switch (pollResponse.decision) {
      case "COMPLETED": {
        log.log("[Agent] Run completed");
        await apiClient.completeRun(runId);
        finalStatus = "completed";
        break;
      }

      case "WAIT": {
        const waitMs = Math.min(5000, Math.max(500, pollResponse.wait_ms ?? 1500));
        log.log(`[Agent] WAIT ${waitMs}ms: ${pollResponse.reasoning}`);
        orchestrator.notifyRunning(workflow.name, currentStepIndex, totalSteps, runId);
        sendOverlay(targetTabId, { step: currentStepIndex, total: totalSteps, action_type: "waiting", workflow_name: workflow.name });
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      case "RESTART": {
        const url = pollResponse.command?.value || pollResponse.command?.target || workflow.target_url;
        if (!url) {
          log.error("[Agent] RESTART without target URL");
          finalStatus = "failed";
          break;
        }
        log.log(`[Agent] Restarting run from ${url}`);
        await chrome.tabs.update(targetTabId, { url });
        await waitForTabLoadBestEffort(targetTabId, "restart");
        commandExecutor.clearTabCache(targetTabId);
        currentStepIndex = 0;
        continue;
      }

      case "ROLLBACK": {
        const url = pollResponse.command?.value || pollResponse.command?.target;
        if (!url) {
          log.error("[Agent] ROLLBACK without checkpoint URL");
          finalStatus = "failed";
          break;
        }
        log.log(`[Agent] Rolling back to step ${pollResponse.next_step_index}: ${url}`);
        await chrome.tabs.update(targetTabId, { url });
        await waitForTabLoadBestEffort(targetTabId, "rollback");
        commandExecutor.clearTabCache(targetTabId);
        currentStepIndex = pollResponse.next_step_index ?? currentStepIndex;
        continue;
      }

      case "PAUSE": {
        // Don't immediately break out of the loop — the auto-recovery
        // supervisor on the backend may produce a fresh decision within
        // 30-60s. Back off and re-poll. After a sustained pause window
        // (`pauseRePollCap` polls) we give up and surface waiting_for_user.
        pausePollCount++;
        log.log(`[Agent] Paused (poll ${pausePollCount}/${pauseRePollCap}): ${pollResponse.pause_reason}`);
        orchestrator.notifyWaiting(
          runId,
          pollResponse.pause_reason || "Agent paused",
        );
        if (pausePollCount >= pauseRePollCap) {
          sendOverlay(targetTabId, null);
          finalStatus = "waiting_for_user";
          break;
        }
        await new Promise((r) => setTimeout(r, 10000));  // 10s backoff
        continue;
      }

      case "ADAPT": {
        const adaptCmd = pollResponse.command;
        if (!adaptCmd) {
          log.error("[Agent] ADAPT without command");
          finalStatus = "failed";
          break;
        }
        log.log(`[Agent] Adapting step ${currentStepIndex}: ${pollResponse.reasoning}`);
        orchestrator.notifyRecovering(workflow.name, currentStepIndex, totalSteps, runId, pollResponse.reasoning);

        const adaptResult = await commandExecutor.executeCommand(targetTabId, adaptCmd);
        lastResultSuccess = adaptResult.success;
        if (!adaptResult.success && isFatalError(adaptResult.error)) {
          await apiClient.failRun(runId, adaptResult.error!);
          finalStatus = "failed";
          break;
        }
        const adaptResultResponse = await apiClient.agentResult(runId, {
          step_index: currentStepIndex,
          success: adaptResult.success,
          error: adaptResult.error || null,
          page_context_after: null,
        });

        if (adaptResult.success) {
          log.log(`[Agent] Adapted step ${currentStepIndex} succeeded`);
          currentStepIndex++;
        } else {
          log.error(`[Agent] Adapted step ${currentStepIndex} failed: ${adaptResult.error}`);
        }

        if (adaptResultResponse.decision === "COMPLETED") {
          finalStatus = "completed";
        } else if (adaptResultResponse.should_poll) {
          continue;
        }
        break;
      }

      case "SKIP": {
        log.log(`[Agent] Skipping step ${currentStepIndex}: ${pollResponse.reasoning}`);
        currentStepIndex = pollResponse.next_step_index ?? currentStepIndex + 1;
        break;
      }

      case "EXECUTE": {
        const cmd = pollResponse.command;
        if (!cmd) {
          log.error("[Agent] EXECUTE without command");
          finalStatus = "failed";
          break;
        }

        orchestrator.notifyRunning(
          workflow.name, currentStepIndex, totalSteps, runId,
        );
        sendOverlay(targetTabId, { step: currentStepIndex, total: totalSteps, action_type: cmd.action ?? "execute", workflow_name: workflow.name });

        if (cmd.action === "navigate") {
          const url = cmd.value || cmd.target;
          if (url) {
            await chrome.tabs.update(targetTabId, { url });
            await waitForTabLoadBestEffort(targetTabId, "execute_navigate");
            // Allow SPA re-render after hash-based navigation (waitForTabLoad
            // returns immediately for same-origin hash changes).
            await new Promise((r) => setTimeout(r, 1500));
          }
          lastResultSuccess = true;
          const resultResponse = await apiClient.agentResult(runId, {
            step_index: currentStepIndex,
            success: true,
            error: null,
            page_context_after: null,
          });
          if (resultResponse.decision === "COMPLETED") {
            finalStatus = "completed";
            break;
          }
          currentStepIndex++;
        } else {
          // Honour pre-execution delay requested by the AI (e.g. page settling).
          if (cmd.delay_before_ms && cmd.delay_before_ms > 0) {
            await new Promise((r) => setTimeout(r, cmd.delay_before_ms));
          }

          // Capture URL before so we can detect click-triggered navigation
          let agentBeforeUrl: string | undefined;
          try { agentBeforeUrl = (await chrome.tabs.get(targetTabId)).url; } catch { /* no-op */ }

          const execResult = await commandExecutor.executeCommand(
            targetTabId, cmd,
          );
          lastResultSuccess = execResult.success;
          if (!execResult.success && isFatalError(execResult.error)) {
            await apiClient.failRun(runId, execResult.error!);
            finalStatus = "failed";
            break;
          }

          if (execResult.success) {
            log.log(`[Agent] Step ${currentStepIndex} OK`);
            // Allow navigation triggered by the click to start, then wait for
            // the page (or SPA) to settle before the next captureContext.
            await new Promise((r) => setTimeout(r, 300));
            try {
              const afterTab = await chrome.tabs.get(targetTabId);
              if (afterTab.status === "loading") {
                await waitForTabLoad(targetTabId, 10000);
              } else if (agentBeforeUrl && afterTab.url !== agentBeforeUrl) {
                // Hash / SPA navigation: page stays "complete" but needs render time
                await new Promise((r) => setTimeout(r, 2000));
              }
            } catch { /* no-op if tab gone */ }
          } else {
            log.error(`[Agent] Step ${currentStepIndex} failed: ${execResult.error}`);
          }

          let errorContext = "";
          let pageContextAfter = null;
          if (!execResult.success && targetTabId) {
            try {
              const ctx = await commandExecutor.captureContext(targetTabId);
              errorContext = ctx.dom_snippet || ctx.visible_text || "";
              pageContextAfter = ctx;
            } catch {
              // context capture best-effort
            }
          }

          const resultResponse = await apiClient.agentResult(runId, {
            step_index: currentStepIndex,
            success: execResult.success,
            error: execResult.error || null,
            page_context_after: pageContextAfter,
            error_context: errorContext || undefined,
            via_method_index: execResult.via_method_index,
            // Workstream A: surface run_script outputs to the backend audit.
            ...(execResult.script_result !== undefined && {
              script_result: execResult.script_result,
            }),
            ...(execResult.script_logs && execResult.script_logs.length > 0 && {
              script_logs: execResult.script_logs,
            }),
            ...(execResult.script_duration_ms !== undefined && {
              script_duration_ms: execResult.script_duration_ms,
            }),
          });

          const next = resultResponse.decision;
          log.log(`[Agent] Result: accepted=${resultResponse.accepted} decision=${next}`);

          if (resultResponse.ai_analysis) {
            log.log(
              `[Agent] AI analysis: cause=${resultResponse.ai_analysis.likely_cause} ` +
              `confidence=${resultResponse.ai_analysis.confidence}`,
            );
          }

          if (next === "COMPLETED") {
            log.log("[Agent] All steps done");
            finalStatus = "completed";
            break;
          }
          if (resultResponse.should_poll) {
            log.log(`[Agent] Step ${currentStepIndex} failed; re-polling for a new strategy`);
            continue;
          }
          if (execResult.success) {
            currentStepIndex++;
          }
        }
        break;
      }

      default:
        log.error(`[Agent] Unknown decision: ${pollResponse.decision}`);
        finalStatus = "failed";
        break;
    }

    if (finalStatus !== "running") break;

    await new Promise((r) => setTimeout(r, 200));
  }

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the user canceled the run, the loop may throw a 409 from a terminal
    // API call racing against the cancel. Suppress the error cleanly.
    if (canceledRuns.has(runId)) {
      canceledRuns.delete(runId);
      finalStatus = "canceled";
    } else {
      log.error(`[Agent] Run loop crashed: ${message}`);
      try {
        await apiClient.pauseRun(
          runId,
          `Extension agent stopped unexpectedly: ${message}`,
          currentStepIndex,
        );
      } catch (pauseErr) {
        log.error("[Agent] Failed to pause crashed run:", pauseErr);
      }
      orchestrator.notifyWaiting(
        runId,
        `Extension agent stopped unexpectedly: ${message}`,
      );
      if (targetTabId) sendOverlay(targetTabId, null);
      finalStatus = "waiting_for_user";
    }
  }

  if (targetTabId) sendOverlay(targetTabId, null);

  if (finalStatus === "completed") {
    const hasExtractSteps = steps.some(
      (s) => (s as { action_type?: string }).action_type === "extract",
    );
    if (targetTabId && !hasExtractSteps) {
      await extractAndReportRunData(workflowId, runId, targetTabId, currentStepIndex);
    }
    orchestrator.notifyIdle();
    orchestrator.broadcastState();
  } else if (finalStatus === "failed") {
    orchestrator.notifyFailed(
      workflow.name,
      currentStepIndex,
      totalSteps,
      runId,
      "Agent run failed",
    );
  }
  // "canceled" and "waiting_for_user" need no further API calls — the run is
  // already in the target terminal state on the backend.
  await clearRunTab(runId);
  if (targetTabId) antiBotByTab.delete(targetTabId);
  canceledRuns.delete(runId);
  return { id: runId, status: finalStatus, total_steps: totalSteps };
}

// Create a run tagged for the unattended daemon and hand off — do NOT run the
// agent loop here (the daemon polls it up and drives it via the run protocol).
// The caller shows status by polling GET /v1/runs/{id} + links to the dashboard.
// Map a chrome.cookies sameSite value to the Playwright cookie shape the daemon
// injects via context.addCookies. "None" requires secure:true or Playwright rejects it.
function mapSameSite(s?: string): "Strict" | "Lax" | "None" {
  if (s === "strict") return "Strict";
  if (s === "no_restriction") return "None";
  return "Lax"; // "lax" | "unspecified" | undefined
}

// Read the user's CURRENT browser cookies for the workflow's target site so a
// daemon run can be authenticated as the user ("Load browser session" toggle).
// Requires the "cookies" manifest permission + host permission for the domain.
async function readSessionCookies(targetUrl?: string): Promise<Array<Record<string, unknown>>> {
  if (!targetUrl) return [];
  try {
    const raw = await chrome.cookies.getAll({ url: targetUrl });
    return raw.map((c) => {
      const sameSite = mapSameSite(c.sameSite);
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        httpOnly: !!c.httpOnly,
        secure: sameSite === "None" ? true : !!c.secure,
        sameSite,
        expires: typeof c.expirationDate === "number" ? Math.floor(c.expirationDate) : -1,
      };
    });
  } catch (e) {
    log.error("[Daemon] readSessionCookies failed", e);
    return [];
  }
}

async function enqueueDaemonRun(
  workflowId: string,
  goal?: string,
  runtimeParams?: Record<string, unknown>,
  loadSession?: boolean,
  targetUrl?: string,
): Promise<{ id: string; status: string; total_steps: number }> {
  // Read cookies BEFORE creating the run; the run is created QUEUED, then we
  // upload the cookies as a session_cookies artifact the daemon consumes once.
  const cookies = loadSession ? await readSessionCookies(targetUrl) : [];
  const run = await apiClient.runWithParams(
    workflowId, runtimeParams || {}, goal, "daemon", { load_session: !!loadSession },
  );
  log.log(`[Daemon] Enqueued run ${run.id} for workflow ${workflowId} — daemon will drive it`);
  if (loadSession && cookies.length && run.id) {
    try {
      const blob = new Blob([JSON.stringify(cookies)], { type: "application/json" });
      await apiClient.uploadArtifact(run.id, 0, "session_cookies", blob, "cookies.json");
      log.log(`[Daemon] uploaded ${cookies.length} session cookies for run ${run.id}`);
    } catch (e) {
      log.error("[Daemon] session cookie upload failed", e);
    }
  }
  return { id: run.id, status: run.status || "queued", total_steps: run.total_steps || 0 };
}

registerServiceWorkerListeners({
  canceledRuns,
  sendOverlay,
  executeAgentRun,
  enqueueDaemonRun,
  executeStepOnTab,
  analyzePageStep,
  analyzeLivePage,
});

if (typeof self !== "undefined") {
  const g = self as unknown as Record<string, unknown>;
  g.__executeWorkflowRun = executeWorkflowRun;
  g.__executeAgentRun = executeAgentRun;
  g.__SR_startRecording = () => orchestrator.startRecording();
  g.__SR_stopRecording = () => orchestrator.stopRecording();
  // Workstream D: expose the CommandExecutor instance so E2E specs can
  // invoke runScript / captureScreenshot without driving a full AI loop.
  g.__SR_commandExecutor = commandExecutor;
}

export { detectChallenges };
