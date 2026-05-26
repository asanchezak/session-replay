import {
  captureClick,
  captureInput,
  captureScroll,
  capturePageContext,
  type CaptureResult,
} from "./capture";
import { captureDomSnippet } from "./dom";
import { executeStep, type StepToExecute, type StepResult } from "./replay";
import { extractStructuredData, extractStructuredDataWithMissing } from "./extraction";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

// ── Inline challenge detection (avoids cross-entry chunking in MV3) ──

interface ChallengeDetection {
  detected: boolean;
  type: string | null;
  confidence: number;
  description: string | null;
}

function detectChallenges(): ChallengeDetection[] {
  const results: ChallengeDetection[] = [];

  const visible = (el: Element): boolean => {
    const html = el as HTMLElement;
    const style = window.getComputedStyle(html);
    const rect = html.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width >= 20 &&
      rect.height >= 20
    );
  };
  
  // Captcha check
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    '[data-sitekey]',
  ];
  for (const sel of captchaSelectors) {
    const el = document.querySelector(sel);
    if (el && visible(el)) {
      results.push({ detected: true, type: "captcha", confidence: 0.95, description: "CAPTCHA detected" });
      break;
    }
  }
  if (!results.some((r) => r.type === "captcha")) {
    const captchaContainers = document.querySelectorAll<HTMLElement>(
      'div[class*="captcha" i], div[id*="captcha" i]',
    );
    for (const el of captchaContainers) {
      if (visible(el) && /captcha|verify you are human|not a robot/i.test(el.innerText || "")) {
        results.push({ detected: true, type: "captcha", confidence: 0.9, description: "CAPTCHA detected" });
        break;
      }
    }
  }
  
  // Login check
  const pwFields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
  const visiblePw = Array.from(pwFields).filter(f => {
    const style = window.getComputedStyle(f);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  if (visiblePw.length > 0) {
    results.push({ detected: true, type: "login_form", confidence: 0.85, description: "Login form detected" });
  }
  
  // Unexpected modal check
  const modals = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"], .modal, .overlay');
  for (const m of modals) {
    const s = window.getComputedStyle(m);
    if (s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0" && m.offsetWidth > 0) {
      results.push({ detected: true, type: "unexpected_modal", confidence: 0.85, description: "Modal detected" });
      break;
    }
  }
  
  return results;
}

const STORAGE_KEY = "recording_state";

let recordingEnabled = false;
let eventCount = 0;

// Events captured before the async storage read resolves are buffered here so
// we don't silently drop them during the init window (~5-50 ms after page load).
let _initResolved = false;
const _earlyEventBuffer: CaptureResult[] = [];

function sendDebugLog(level: string, msg: string): void {
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", level, message: msg, source: "content-script" }).catch(() => {});
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as { type?: string; [key: string]: unknown } | undefined;
  if (!data) return;
  if (data.type === "DASHBOARD_RUN_WORKFLOW") {
    const workflowId = data.workflowId as string | undefined;
    const goal = typeof data.goal === "string" ? data.goal : undefined;
    const params = data.params && typeof data.params === "object"
      ? data.params as Record<string, unknown>
      : undefined;
    if (!workflowId) return;
    sendDebugLog("log", `Dashboard triggered run for workflow ${workflowId}`);
    chrome.runtime.sendMessage({ type: "RUN_WORKFLOW", workflowId, goal, params })
      .then((response) => {
        const resp = response as { type: string; run?: { id: string }; error?: string };
        if (resp.type === "RUN_STARTED" && resp.run?.id) {
          window.postMessage(
            { type: "DASHBOARD_RUN_STARTED", runId: resp.run.id },
            "*",
          );
        } else if (resp.type === "RUN_FAILED") {
          window.postMessage(
            {
              type: "DASHBOARD_RUN_FAILED",
              error: resp.error || "Failed to start workflow run",
            },
            "*",
          );
        }
      })
      .catch(() => {});
    return;
  }
  if (data.type === "DASHBOARD_ANALYZE_PAGE") {
    const workflowId = data.workflowId as string | undefined;
    const stepIndex = typeof data.stepIndex === "number" ? data.stepIndex : undefined;
    const pageUrl = typeof data.pageUrl === "string" ? data.pageUrl : undefined;
    if (!workflowId || stepIndex === undefined || !pageUrl) return;
    sendDebugLog("log", `Dashboard triggered page analysis for workflow ${workflowId} step ${stepIndex}`);
    chrome.runtime.sendMessage({ type: "ANALYZE_PAGE_STEP", workflowId, stepIndex, pageUrl })
      .then((response) => {
        const resp = response as {
          type: string;
          analysis?: Record<string, unknown>;
          error?: string;
        };
        if (resp.type === "ANALYZE_PAGE_STEP_RESULT" && resp.analysis) {
          window.postMessage(
            { type: "DASHBOARD_PAGE_ANALYSIS_READY", analysis: resp.analysis },
            "*",
          );
        } else {
          window.postMessage(
            {
              type: "DASHBOARD_PAGE_ANALYSIS_FAILED",
              error: resp.error || "Failed to analyze page",
            },
            "*",
          );
        }
      })
      .catch(() => {
        window.postMessage(
          { type: "DASHBOARD_PAGE_ANALYSIS_FAILED", error: "Failed to analyze page" },
          "*",
        );
      });
  }
});

sendDebugLog("log", "Content script loaded");

// Test helper: when the dashboard URL carries ?sr_autorun=<workflowId>, post
// the DASHBOARD_RUN_WORKFLOW message automatically once the page settles.
// Lets the trusted-click verifier kick off a run without external CDP
// (Playwright/Puppeteer) — which would conflict with chrome.debugger.attach
// inside the extension. Scoped strictly to the dashboard origin so it can't
// be abused from another site.
(() => {
  try {
    if (window.location.origin !== "http://localhost:5173") return;
    const url = new URL(window.location.href);
    const autorun = url.searchParams.get("sr_autorun");
    if (!autorun) return;
    setTimeout(() => {
      sendDebugLog("log", `Auto-triggering DASHBOARD_RUN_WORKFLOW for ${autorun}`);
      window.postMessage({ type: "DASHBOARD_RUN_WORKFLOW", workflowId: autorun }, "*");
    }, 1500);
  } catch { /* malformed URL — ignore */ }
})();

chrome.storage.session.get(STORAGE_KEY).then((data) => {
  const state = data[STORAGE_KEY] as { isRecording: boolean; events: unknown[] } | undefined;
  if (state?.isRecording) {
    recordingEnabled = true;
    eventCount = state.events?.length ?? 0;
    sendDebugLog("log", `Initial state: recording enabled (${eventCount} events)`);
  }
  _initResolved = true;
  // Drain events captured during the async init window.
  if (recordingEnabled && _earlyEventBuffer.length > 0) {
    sendDebugLog("log", `Flushing ${_earlyEventBuffer.length} buffered early event(s)`);
    for (const ev of _earlyEventBuffer) {
      _dispatchToBackground(ev);
    }
  }
  _earlyEventBuffer.length = 0;
  // Signal readiness only after recording state is resolved so waitForContentScript
  // guarantees recordingEnabled is correct before the first captured event.
  (window as any).__SR_CONTENT_SCRIPT__ = true;
}).catch(() => {
  _initResolved = true;
  _earlyEventBuffer.length = 0;
  (window as any).__SR_CONTENT_SCRIPT__ = true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  const relevantKeys = Object.keys(changes).filter(k => k === STORAGE_KEY || k.startsWith("recording_"));
  if (relevantKeys.length === 0) return;
  if (changes[STORAGE_KEY]) {
    const state = changes[STORAGE_KEY].newValue;
    recordingEnabled = state?.isRecording ?? false;
    eventCount = state?.events?.length ?? 0;
    if (!recordingEnabled) _hideExtractButton();
    sendDebugLog("log", `Storage: recording ${recordingEnabled ? "enabled" : "disabled"} (${eventCount} events)`);
  }
});

// Polling fallback: sync recording state from storage every 2 seconds.
// This ensures the content script recovers even if onChanged doesn't fire
// (e.g., setAccessLevel call failed, or message race conditions).
setInterval(() => {
  if (!recordingEnabled) {
    chrome.storage.session.get(STORAGE_KEY).then((data) => {
      const state = data[STORAGE_KEY] as { isRecording: boolean; events: unknown[] } | undefined;
      if (state?.isRecording && !recordingEnabled) {
        recordingEnabled = true;
        eventCount = state.events?.length ?? 0;
        sendDebugLog("log", `Polling fallback: recording enabled (${eventCount} events)`);
      }
    }).catch(() => {});
  }
}, 500);

// ── Shadow DOM Replay UI ──────────────────────────────────────────

const SHADOW_STYLES = `
  :host { all: initial; position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; }
  .sr-panel {
    background: #1A1D27; color: #E8EAED; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; padding: 12px 16px; border-radius: 10px; border: 1px solid #2D3148;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5); min-width: 260px;
  }
  .sr-panel .step { color: #74B9FF; font-weight: 500; margin-bottom: 6px; }
  .sr-panel .progress { height: 4px; background: #2A2E3D; border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
  .sr-panel .progress-bar { height: 100%; background: #6C5CE7; border-radius: 2px; transition: width 0.3s ease; }
  .sr-panel .controls { display: flex; gap: 8px; }
  .sr-panel button {
    padding: 6px 12px; border-radius: 6px; border: none; font-size: 12px; cursor: pointer;
    background: #242836; color: #E8EAED;
  }
  .sr-panel button:hover { background: #2A2E3D; }
  .sr-panel .status { font-size: 11px; color: #9AA0B0; margin-top: 4px; }
`;

let shadowHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;

function buildShadowPanel(): HTMLDivElement {
  const panel = document.createElement("div");
  panel.className = "sr-panel";

  const stepDiv = document.createElement("div");
  stepDiv.className = "step";
  panel.appendChild(stepDiv);

  const progress = document.createElement("div");
  progress.className = "progress";
  const progressBar = document.createElement("div");
  progressBar.className = "progress-bar";
  progress.appendChild(progressBar);
  panel.appendChild(progress);

  const statusDiv = document.createElement("div");
  statusDiv.className = "status";
  panel.appendChild(statusDiv);

  return panel;
}

export function showReplayPanel(step: number, total: number, status: string): void {
  if (!shadowHost || !shadowHost.isConnected) {
    shadowHost = document.createElement("div");
    shadowHost.id = "sr-replay-panel";
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = SHADOW_STYLES;
    shadowRoot.appendChild(style);

    shadowRoot.appendChild(buildShadowPanel());
  }
  if (!shadowRoot) return;

  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  const panel = shadowRoot.querySelector(".sr-panel");
  if (!panel) return;

  const stepDiv = panel.querySelector(".step");
  if (stepDiv) stepDiv.textContent = `Step ${step}/${total}`;

  const progressBar = panel.querySelector(".progress-bar") as HTMLElement;
  if (progressBar) progressBar.style.width = `${pct}%`;

  const statusDiv = panel.querySelector(".status");
  if (statusDiv) statusDiv.textContent = status;
}

export function hideReplayPanel(): void {
  if (shadowHost && shadowHost.parentNode) {
    shadowHost.parentNode.removeChild(shadowHost);
  }
  shadowHost = null;
  shadowRoot = null;
}

// ── Full-page status overlay (non-blocking) ──────────────────────

const OVERLAY_STYLES = `
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
  .sr-overlay-backdrop {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center;
    pointer-events: none;
  }
  .sr-overlay-card {
    background: #1A1D27; color: #E8EAED;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px; padding: 16px 20px; border-radius: 12px;
    border: 1px solid #2D3148; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    min-width: 280px; max-width: 380px;
    pointer-events: none;
  }
  .sr-overlay-header {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 10px; font-weight: 600; font-size: 14px;
  }
  .sr-overlay-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #6C5CE7;
    animation: sr-pulse 1.4s ease-in-out infinite;
  }
  @keyframes sr-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(0.85); }
  }
  .sr-overlay-name { font-size: 12px; color: #9AA0B0; margin-bottom: 8px; }
  .sr-overlay-step { color: #74B9FF; font-size: 12px; margin-bottom: 8px; }
  .sr-overlay-progress { height: 3px; background: #2A2E3D; border-radius: 2px; overflow: hidden; }
  .sr-overlay-bar { height: 100%; background: #6C5CE7; border-radius: 2px; transition: width 0.3s ease; }
  .sr-overlay-action { font-size: 11px; color: #9AA0B0; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
`;

let overlayHost: HTMLDivElement | null = null;
let overlayShadow: ShadowRoot | null = null;
let suppressScrollRecordingUntil = 0;

async function prepareForCapture(): Promise<void> {
  const startedAt = Date.now();
  sendDebugLog("log", `[capture] prepare start url=${window.location.href}`);
  suppressScrollRecordingUntil = Date.now() + 10_000;
  const deadline = Date.now() + 8_000;
  let stableTicks = 0;
  let lastScrollY = -1;
  while (Date.now() < deadline) {
    const viewport = Math.max(window.innerHeight || 0, 600);
    window.scrollBy({ top: Math.max(Math.floor(viewport * 0.9), 400), behavior: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const currentScrollY = Math.round(window.scrollY || window.pageYOffset || 0);
    if (currentScrollY === lastScrollY) {
      stableTicks += 1;
      if (stableTicks >= 2) break;
    } else {
      stableTicks = 0;
      lastScrollY = currentScrollY;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  suppressScrollRecordingUntil = Date.now() + 1_500;
  sendDebugLog(
    "log",
    `[capture] prepare done elapsed_ms=${Date.now() - startedAt} final_scroll_y=${Math.round(window.scrollY || window.pageYOffset || 0)}`,
  );
}

export function showRunningOverlay(step: number, total: number, actionType: string, workflowName: string): void {
  if (!overlayHost || !overlayHost.isConnected) {
    overlayHost = document.createElement("div");
    overlayHost.id = "sr-running-overlay";
    document.documentElement.appendChild(overlayHost);
    overlayShadow = overlayHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = OVERLAY_STYLES;
    overlayShadow.appendChild(style);

    const backdrop = document.createElement("div");
    backdrop.className = "sr-overlay-backdrop";

    const card = document.createElement("div");
    card.className = "sr-overlay-card";

    const header = document.createElement("div");
    header.className = "sr-overlay-header";
    const dot = document.createElement("span");
    dot.className = "sr-overlay-dot";
    header.appendChild(dot);
    header.appendChild(document.createTextNode("Workflow Running"));

    const name = document.createElement("div");
    name.className = "sr-overlay-name";

    const stepInfo = document.createElement("div");
    stepInfo.className = "sr-overlay-step";

    const progressWrap = document.createElement("div");
    progressWrap.className = "sr-overlay-progress";
    const progressBar = document.createElement("div");
    progressBar.className = "sr-overlay-bar";
    progressWrap.appendChild(progressBar);

    const action = document.createElement("div");
    action.className = "sr-overlay-action";

    card.appendChild(header);
    card.appendChild(name);
    card.appendChild(stepInfo);
    card.appendChild(progressWrap);
    card.appendChild(action);
    backdrop.appendChild(card);
    overlayShadow.appendChild(backdrop);
  }

  if (!overlayShadow) return;
  const pct = total > 0 ? Math.round(((step + 1) / total) * 100) : 0;

  const name = overlayShadow.querySelector(".sr-overlay-name");
  if (name) name.textContent = workflowName;

  const stepEl = overlayShadow.querySelector(".sr-overlay-step");
  if (stepEl) stepEl.textContent = `Step ${step + 1} of ${total}`;

  const bar = overlayShadow.querySelector(".sr-overlay-bar") as HTMLElement | null;
  if (bar) bar.style.width = `${pct}%`;

  const actionEl = overlayShadow.querySelector(".sr-overlay-action");
  if (actionEl) actionEl.textContent = actionType;
}

export function hideRunningOverlay(): void {
  if (overlayHost && overlayHost.parentNode) {
    overlayHost.parentNode.removeChild(overlayHost);
  }
  overlayHost = null;
  overlayShadow = null;
}

// ── Merged onMessage listener (E-C-12) ────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    msg: BackgroundToContentMessage | { type: string; step?: BackgroundToContentMessage["step"]; selectorPattern?: string; enabled?: boolean },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (msg.type) {
      case "EXECUTE_STEP":
        executeStep((msg as BackgroundToContentMessage).step as StepToExecute).then((result) => {
          sendResponse({ type: "STEP_RESULT", ...result });
        });
        return true;
      case "CAPTURE_DOM_SNIPPET":
        sendResponse({ type: "DOM_SNIPPET_RESULT", ...captureDomSnippet((msg as any).selectorPattern || "") });
        break;
      case "SET_RECORDING":
        recordingEnabled = (msg as any).enabled ?? false;
        eventCount = 0;
        if (!recordingEnabled) _hideExtractButton();
        sendDebugLog("log", `Recording ${recordingEnabled ? "enabled" : "disabled"}`);
        sendResponse({ success: true });
        break;
      case "SHOW_OVERLAY": {
        const m = msg as any;
        showRunningOverlay(m.step ?? 0, m.total ?? 1, m.action_type ?? "", m.workflow_name ?? "");
        sendResponse({ ok: true });
        break;
      }
      case "HIDE_OVERLAY":
        hideRunningOverlay();
        sendResponse({ ok: true });
        break;
      case "DETECT_CHALLENGES":
        sendResponse({ type: "CHALLENGES_DETECTED", challenges: detectChallenges() });
        break;
      case "EXTRACT_DATA": {
        // Only the top frame may answer. Otherwise iframes (e.g. LinkedIn
        // tracking pixels at /tscp-serving/...) race the main page and the
        // first responder wins, yielding garbage like {page_title: "Image By
        // Linkedin", url: "<pixel URL>"} instead of the real profile data.
        if (window.top !== window) {
          return false;
        }
        const schema = (msg as any).outputSchema || null;
        const { data, missing_fields } = extractStructuredDataWithMissing(schema);
        sendResponse({
          type: "EXTRACT_DATA_RESULT",
          data,
          missing_fields,
          url: window.location.href,
        });
        break;
      }
      case "CAPTURE_PAGE_CONTEXT":
        if (window.top !== window) {
          return false;
        }
        sendResponse({ type: "PAGE_CONTEXT_RESULT", ...capturePageContext() });
        break;
      case "PREPARE_FOR_CAPTURE":
        if (window.top !== window) {
          return false;
        }
        prepareForCapture()
          .then(() => sendResponse({ type: "PREPARE_FOR_CAPTURE_RESULT", ok: true }))
          .catch(() => sendResponse({ type: "PREPARE_FOR_CAPTURE_RESULT", ok: false }));
        return true;
      case "EXECUTE_AGENT_COMMAND": {
        const cmd = (msg as any).command as {
          action: string;
          selector_chain?: Array<{ type: string; value: string }>;
          value?: string;
          target?: string | null;
          intent?: string;
          timeout_ms?: number;
          methods?: Array<{ action_type: string; selector_chain: Array<{ type: string; value: string }>; value?: string }>;
          success_condition?: Record<string, unknown> | null;
        };
        if (cmd.action === "navigate") {
          const targetUrl = cmd.value || cmd.target;
          if (targetUrl) {
            window.location.href = targetUrl;
            sendResponse({ type: "AGENT_COMMAND_RESULT", success: true });
          } else {
            sendResponse({ type: "AGENT_COMMAND_RESULT", success: false, error: "No URL for navigate" });
          }
        } else {
          const step = {
            action_type: cmd.action,
            selector_chain: cmd.selector_chain || [],
            value: cmd.value || undefined,
            intent: cmd.intent || undefined,
            methods: cmd.methods || undefined,
            success_condition: cmd.success_condition || undefined,
          };
          executeStep(step as StepToExecute).then((result) => {
            sendResponse({ type: "AGENT_COMMAND_RESULT", ...result });
          });
        }
        return true;
      }
    }
    return true;
  },
);

// ── Event capture ──────────────────────────────────────────────────

function summarizeEventForDebug(event: CaptureResult): string {
  try {
    const payload = (event.payload || {}) as Record<string, unknown>;
    const target = (payload.target || {}) as Record<string, unknown>;
    const selectorChain = Array.isArray(payload.selector_chain)
      ? payload.selector_chain as Array<{ type?: string; value?: string }>
      : [];
    const topSelector = selectorChain[0];
    const intent = String(payload.intent || "").slice(0, 100);
    const value = String(payload.value || "");
    const valueHint = value
      ? ` value_len=${value.length}`
      : "";
    const coords = (
      typeof payload.client_x === "number" && typeof payload.client_y === "number"
    )
      ? ` @(${payload.client_x},${payload.client_y})`
      : "";
    const targetText = String(target.text || "").slice(0, 60);
    const selectorHint = topSelector
      ? ` sel=${topSelector.type || "?"}:${String(topSelector.value || "").slice(0, 80)}`
      : "";
    return `${event.event_type}${coords}${valueHint} intent="${intent}" target="${targetText}"${selectorHint}`;
  } catch {
    return `${event.event_type}`;
  }
}

function _dispatchToBackground(event: CaptureResult): void {
  eventCount++;
  sendDebugLog(
    "log",
    `Sending event #${eventCount}: ${summarizeEventForDebug(event)} on ${event.page_url}`,
  );
  chrome.runtime.sendMessage(
    {
      type: "RECORD_EVENT",
      event: {
        event_type: event.event_type,
        payload: event.payload,
        page_url: event.page_url,
        page_title: event.page_title,
        timestamp: event.timestamp,
      },
    } as ContentToBackgroundMessage,
  );
}

function sendToBackground(event: CaptureResult): void {
  if (!_initResolved) {
    // Storage read is still pending — buffer so we don't drop events that
    // happen in the first ~5-50 ms of a new page (e.g. quickly clicking the
    // speedtest "Go" button right after navigation completes).
    _earlyEventBuffer.push(event);
    return;
  }
  if (!recordingEnabled) return;
  _dispatchToBackground(event);
}

// Snapshot of text-input values captured on mousedown, used to detect
// when a custom dropdown click sets an input value without firing "change".
let preClickInputSnapshot: Map<HTMLInputElement, string> | null = null;
// Per-editable-element: last value emitted as a type step, for deduplication.
const recentTypeEmits = new WeakMap<HTMLElement, { value: string; ts: number }>();
// Pending debounced input events. Uses Map (not WeakMap) so we can iterate
// to flush on mousedown — the next click might clear the input (e.g.
// LinkedIn's Send button) before the 450ms debounce fires.  We snapshot the
// value AT input-event time so the flush still emits the typed text.
const pendingInputDebounce = new Map<HTMLElement, { timer: ReturnType<typeof setTimeout>; value: string }>();

const EXCLUDED_INPUT_TYPES = new Set([
  "file", "checkbox", "radio", "submit", "button", "image", "reset", "password",
]);

// Read the live value the user just typed, regardless of whether the target
// is a contenteditable element or a native input/textarea.
function _readEditableValue(el: HTMLElement): string {
  if (el.isContentEditable) return el.textContent || "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value || "";
  return el.textContent || "";
}

// Emit a captured type event with the snapshotted value, bypassing whatever
// the input currently holds (it may have been cleared by a Send handler).
function _emitTypeForTarget(target: HTMLElement, value: string): void {
  if (!recordingEnabled) return;
  if (!value.trim()) return;
  const recent = recentTypeEmits.get(target);
  if (recent && recent.value === value && Date.now() - recent.ts < 500) return;
  recentTypeEmits.set(target, { value, ts: Date.now() });
  sendToBackground(captureInput({ target } as unknown as Event, value));
}

// Cancel all pending debounce timers and emit their snapshotted values
// synchronously. Called from mousedown so the type step lands BEFORE the
// click that consumes it (e.g. clicking Send after typing).
function _flushPendingInputDebounces(): void {
  if (pendingInputDebounce.size === 0) return;
  // Copy entries so the map can be mutated during iteration.
  const entries = Array.from(pendingInputDebounce.entries());
  pendingInputDebounce.clear();
  for (const [target, entry] of entries) {
    clearTimeout(entry.timer);
    _emitTypeForTarget(target, entry.value);
  }
}

document.addEventListener("mousedown", () => {
  if (_initResolved && !recordingEnabled) return;
  // Critical: flush any pending input debounce BEFORE this click executes.
  // LinkedIn's Send button (and similar "submit-and-clear" UI) clears the
  // compose box synchronously inside the click handler — if we let the 450ms
  // debounce fire afterwards, target.textContent is already "" and the type
  // step is lost. Flushing here also guarantees type events ordering before
  // the click that triggered them.
  _flushPendingInputDebounces();

  preClickInputSnapshot = new Map();
  // Snapshot ALL text-like inputs — broad selector so custom dropdowns backed by
  // any input type (text, hidden, email, search, …) are included.
  document.querySelectorAll<HTMLInputElement>("input").forEach((el) => {
    if (EXCLUDED_INPUT_TYPES.has(el.type.toLowerCase())) return;
    if (el.name || el.id) {
      preClickInputSnapshot!.set(el, el.value);
    }
  });
}, true);

// Use capture phase (true) so we see every click before any child handler can
// call stopPropagation() — critical for navigation links in SPA frameworks.
document.addEventListener("click", (e: MouseEvent) => {
  if (!recordingEnabled) return;
  if (Date.now() < _suppressSelectionClicksUntil) return;
  const target = e.target as HTMLElement | null;
  if (target?.id === "sr-extract-host") return;
  const snapshot = preClickInputSnapshot;
  preClickInputSnapshot = null;
  sendToBackground(captureClick(e));

  if (!snapshot || snapshot.size === 0) return;
  // 300ms after the click, check whether a custom dropdown updated any input
  // value without firing a "change" event.
  setTimeout(() => {
    if (!recordingEnabled) return;
    snapshot.forEach((prevValue, input) => {
      if (!document.contains(input)) return;
      const newValue = input.value;
      if (!newValue || newValue === prevValue) return;
      const recent = recentTypeEmits.get(input);
      if (recent && recent.value === newValue && Date.now() - recent.ts < 500) return;
      recentTypeEmits.set(input, { value: newValue, ts: Date.now() });
      sendToBackground(captureInput({ target: input } as unknown as Event));
    });
  }, 300);
}, true);  // ← capture phase

// ── Selection-based extract button during recording ──────────────

const EXTRACT_BUTTON_STYLES = `
  :host { all: initial; position: fixed; z-index: 2147483645; }
  .sr-extract-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; border-radius: 8px;
    background: #6C5CE7; color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 12px; font-weight: 500;
    border: none; cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    white-space: nowrap;
    transition: background 0.15s;
  }
  .sr-extract-btn:hover { background: #7C6EF7; }
  .sr-extract-hint {
    font-size: 10px; color: rgba(255,255,255,0.65);
    margin-top: 4px; text-align: center;
  }
`;

let _extractHost: HTMLDivElement | null = null;
let _extractShadow: ShadowRoot | null = null;
let _extractTimer: ReturnType<typeof setTimeout> | null = null;
let _selectionDebounce: ReturnType<typeof setTimeout> | null = null;
let _suppressSelectionClicksUntil = 0;
let _lastExtractSelection: {
  selectedText: string;
  containerText: string;
  containerSelector: string;
} | null = null;

function _clearExtractTimer(): void {
  if (_extractTimer) { clearTimeout(_extractTimer); _extractTimer = null; }
}

function _getContainerText(target: Node): string {
  const container = (target as Element).closest?.(
    "article, section, main, [role='main'], .profile, .card, .pv-profile-card, .entity-result__item",
  ) as HTMLElement | null;
  const source = container || document.body;
  return (source.textContent || "").trim().slice(0, 5000);
}

function _getContainerSelector(target: Node): string {
  if (target instanceof Element) {
    const id = target.id;
    if (id) return `#${CSS.escape(id)}`;
    const cls = (target as HTMLElement).className;
    if (typeof cls === "string" && cls.trim()) {
      return `${target.tagName.toLowerCase()}.${cls.trim().split(/\s+/).slice(0, 2).join(".")}`;
    }
    return target.tagName.toLowerCase();
  }
  return "";
}

function _showExtractButton(rect: DOMRect): void {
  _clearExtractTimer();

  if (!_extractHost || !_extractHost.isConnected) {
    _extractHost = document.createElement("div");
    _extractHost.id = "sr-extract-host";
    document.body.appendChild(_extractHost);
    _extractShadow = _extractHost.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = EXTRACT_BUTTON_STYLES;
    _extractShadow.appendChild(style);

    const btn = document.createElement("button");
    btn.className = "sr-extract-btn";
    btn.textContent = "⊕ Extract These Fields";
    btn.title = "Select column headers or field labels to extract structured data";
    btn.addEventListener("mousedown", (e) => {
      // Fire extraction before focus/selection can change.
      e.preventDefault();
      e.stopPropagation();
      _handleExtractClick();
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    _extractShadow.appendChild(btn);

    const hint = document.createElement("div");
    hint.className = "sr-extract-hint";
    hint.textContent = "AI will infer the fields to extract";
    _extractShadow.appendChild(hint);
  }

  const btnW = 180;
  const btnH = 56;
  let top = rect.bottom + 8;
  let left = rect.right;

  if (left + btnW > window.innerWidth - 8) left = window.innerWidth - btnW - 8;
  if (top + btnH > window.innerHeight - 8) top = rect.top - btnH - 8;
  if (left < 8) left = 8;
  if (top < 8) top = 8;

  _extractHost.style.top = `${top}px`;
  _extractHost.style.left = `${left}px`;

  _extractTimer = setTimeout(_hideExtractButton, 8000);
}

function _hideExtractButton(): void {
  _clearExtractTimer();
  if (_extractHost && _extractHost.parentNode) {
    _extractHost.parentNode.removeChild(_extractHost);
  }
  _extractHost = null;
  _extractShadow = null;
}

function _handleExtractClick(): void {
  _suppressSelectionClicksUntil = Date.now() + 1200;
  const sel = window.getSelection();
  const selectedText = (!sel || sel.isCollapsed) ? "" : sel.toString().trim();
  const selectedFromSnapshot = _lastExtractSelection?.selectedText || "";
  const effectiveSelectedText = selectedText || selectedFromSnapshot;
  if (!effectiveSelectedText) {
    sendDebugLog("log", "[extract] click ignored: no selected text");
    return;
  }

  let containerText = _lastExtractSelection?.containerText || "";
  let containerSelector = _lastExtractSelection?.containerSelector || "";

  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    containerText = _getContainerText(range.startContainer);
    containerSelector = _getContainerSelector(
      range.startContainer.parentElement || range.startContainer,
    );
  }

  chrome.runtime.sendMessage({
    type: "SELECTION_INTENT",
    selected_text: effectiveSelectedText,
    container_text: containerText,
    page_url: window.location.href,
    page_title: document.title,
    container_selector: containerSelector,
    timestamp: new Date().toISOString(),
  }).then(() => {
    sendDebugLog("log", `[extract] selection intent sent (${effectiveSelectedText.length} chars)`);
  }).catch((err) => {
    sendDebugLog("error", `[extract] failed to send selection intent: ${String(err)}`);
  });

  // Brief feedback
  if (_extractShadow) {
    const btn = _extractShadow.querySelector(".sr-extract-btn");
    if (btn) {
      btn.textContent = "✓ Extraction Marked";
      (btn as HTMLElement).style.background = "#00B894";
    }
  }
  setTimeout(_hideExtractButton, 1200);
}

function _checkSelectionAndShow(): void {
  if (!recordingEnabled) { _hideExtractButton(); return; }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    _lastExtractSelection = null;
    _hideExtractButton();
    return;
  }

  const activeEl = document.activeElement;
  if (
    activeEl instanceof HTMLInputElement ||
    activeEl instanceof HTMLTextAreaElement ||
    (activeEl instanceof HTMLElement && activeEl.isContentEditable)
  ) {
    return;
  }

  let rect: DOMRect | null = null;
  try {
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(sel.rangeCount - 1);
    _lastExtractSelection = {
      selectedText: sel.toString().trim(),
      containerText: _getContainerText(range.startContainer),
      containerSelector: _getContainerSelector(
        range.startContainer.parentElement || range.startContainer,
      ),
    };
    rect = range.getBoundingClientRect();
  } catch {
    const anchor = sel.anchorNode;
    if (anchor && anchor.parentElement) {
      rect = anchor.parentElement.getBoundingClientRect();
    }
  }
  if (!rect || isNaN(rect.top) || (rect.width === 0 && rect.height === 0)) return;

  _showExtractButton(rect);
}

// Primary: selectionchange catches keyboard selection (Shift+Arrow, Ctrl+A)
document.addEventListener("selectionchange", () => {
  if (!recordingEnabled) return;
  if (_selectionDebounce) clearTimeout(_selectionDebounce);
  _selectionDebounce = setTimeout(() => {
    _selectionDebounce = null;
    _checkSelectionAndShow();
  }, 150);
});

// Supplementary: mouseup gives precise positioning for mouse-driven selections
document.addEventListener("mouseup", () => {
  if (!recordingEnabled) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) {
    _suppressSelectionClicksUntil = Date.now() + 1200;
  }
  _hideExtractButton();
  setTimeout(() => {
    if (!recordingEnabled) return;
    _checkSelectionAndShow();
  }, 10);
}, true);

// Hide button on click-away (but not when clicking the button itself)
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!_extractHost) return;
  const path = e.composedPath();
  if (path.includes(_extractHost)) return;
  _suppressSelectionClicksUntil = 0;
  _hideExtractButton();
}, true);

// Clean up button on page unload
window.addEventListener("pagehide", () => _hideExtractButton());
window.addEventListener("beforeunload", () => _hideExtractButton());

// Capture phase for change too — catches events that child handlers stop.
document.addEventListener("change", (e: Event) => {
  if (!recordingEnabled) return;
  // Pierce shadow DOM retargeting: e.target is the shadow host; composedPath()[0]
  // is the actual input/select/textarea element that fired the event.
  const innerTarget = (e as { composedPath?: () => EventTarget[] }).composedPath?.()[0] ?? e.target;
  const tag = innerTarget instanceof Element ? innerTarget.tagName.toLowerCase() : "";
  const isInput = innerTarget instanceof HTMLInputElement || tag === "input";
  const isSelect = innerTarget instanceof HTMLSelectElement || tag === "select";
  const isTextarea = innerTarget instanceof HTMLTextAreaElement || tag === "textarea";

  if (isInput || isSelect || isTextarea) {
    if (isInput && innerTarget instanceof HTMLInputElement &&
        !EXCLUDED_INPUT_TYPES.has(innerTarget.type.toLowerCase())) {
      recentTypeEmits.set(innerTarget, { value: innerTarget.value, ts: Date.now() });
    }
    sendToBackground(captureInput(e));  // captureInput resolves composedPath() itself
  }
}, true);  // ← capture phase

// Debounce text input across BOTH contenteditable elements (LinkedIn compose
// box) AND regular inputs/textareas (LinkedIn search box). The previous
// implementation only handled contenteditable, so typing into the search
// input never produced a type step — it relied on the 'change' listener,
// which fires only on blur, often after the user has already clicked away.
//
// Two race-fixes baked in:
//   1. Value is snapshotted at THIS event time, not when the timer fires —
//      so a clear-on-submit (Send button) doesn't erase our captured value.
//   2. mousedown calls _flushPendingInputDebounces() so type lands BEFORE the
//      click step it precedes (and before any handler can wipe the input).
document.addEventListener("input", (e: Event) => {
  if (!recordingEnabled) return;
  const innerTarget = (e as { composedPath?: () => EventTarget[] }).composedPath?.()[0] ?? e.target;
  const target = (innerTarget instanceof HTMLElement ? innerTarget : e.target) as HTMLElement | null;
  if (!(target instanceof HTMLElement)) return;

  const isContentEditable = target.isContentEditable;
  const isInput = target instanceof HTMLInputElement
    && !EXCLUDED_INPUT_TYPES.has(target.type.toLowerCase());
  const isTextarea = target instanceof HTMLTextAreaElement;
  if (!isContentEditable && !isInput && !isTextarea) return;

  const value = _readEditableValue(target);

  const prev = pendingInputDebounce.get(target);
  if (prev) clearTimeout(prev.timer);

  const timer = setTimeout(() => {
    const entry = pendingInputDebounce.get(target);
    if (!entry) return;
    pendingInputDebounce.delete(target);
    // .isConnected works for shadow-DOM elements; document.contains() does not.
    if (!target.isConnected) return;
    _emitTypeForTarget(target, entry.value);
  }, 450);

  pendingInputDebounce.set(target, { timer, value });
}, true);

// ── Scroll listener with AbortController (E-C-11) ──────────────────

let scrollController: AbortController | null = null;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

function handleScroll(event: Event): void {
  if (!recordingEnabled) return;
  if (Date.now() < suppressScrollRecordingUntil) return;
  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    sendToBackground(captureScroll(event));
  }, 500);
}

function initScrollListener(): void {
  if (scrollController) {
    scrollController.abort();
  }
  scrollController = new AbortController();
  document.addEventListener("scroll", handleScroll, {
    signal: scrollController.signal,
    passive: true,
  });
}

initScrollListener();
