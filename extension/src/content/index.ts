import {
  captureClick,
  captureInput,
  captureScroll,
  capturePageContext,
  type CaptureResult,
} from "./capture";
import { captureDomSnippet } from "./dom";
import { executeStep, type StepToExecute, type StepResult } from "./replay";
import { extractStructuredData } from "./extraction";
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
  if (!data || data.type !== "DASHBOARD_RUN_WORKFLOW") return;
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
});

sendDebugLog("log", "Content script loaded");

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
        sendDebugLog("log", `Recording ${recordingEnabled ? "enabled" : "disabled"}`);
        sendResponse({ success: true });
        break;
      case "DETECT_CHALLENGES":
        sendResponse({ type: "CHALLENGES_DETECTED", challenges: detectChallenges() });
        break;
      case "EXTRACT_DATA": {
        const schema = (msg as any).outputSchema || null;
        const data = extractStructuredData(schema);
        sendResponse({
          type: "EXTRACT_DATA_RESULT",
          data,
          url: window.location.href,
        });
        break;
      }
      case "CAPTURE_PAGE_CONTEXT":
        sendResponse({ type: "PAGE_CONTEXT_RESULT", ...capturePageContext() });
        break;
      case "EXECUTE_AGENT_COMMAND": {
        const cmd = (msg as any).command as {
          action: string;
          selector_chain?: Array<{ type: string; value: string }>;
          value?: string;
          target?: string | null;
          intent?: string;
          timeout_ms?: number;
          methods?: Array<{ action_type: string; selector_chain: Array<{ type: string; value: string }>; value?: string }>;
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

function _dispatchToBackground(event: CaptureResult): void {
  eventCount++;
  sendDebugLog("log", `Sending event #${eventCount}: ${event.event_type} on ${event.page_url}`);
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
// Per-input: last value we emitted as a type step, for deduplication.
const recentTypeEmits = new WeakMap<HTMLInputElement, { value: string; ts: number }>();

const EXCLUDED_INPUT_TYPES = new Set([
  "file", "checkbox", "radio", "submit", "button", "image", "reset", "password",
]);

document.addEventListener("mousedown", () => {
  if (_initResolved && !recordingEnabled) return;
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

// Capture phase for change too — catches events that child handlers stop.
document.addEventListener("change", (e: Event) => {
  if (!recordingEnabled) return;
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    if (target instanceof HTMLInputElement && !EXCLUDED_INPUT_TYPES.has(target.type.toLowerCase())) {
      recentTypeEmits.set(target, { value: target.value, ts: Date.now() });
    }
    sendToBackground(captureInput(e));
  }
}, true);  // ← capture phase

// ── Scroll listener with AbortController (E-C-11) ──────────────────

let scrollController: AbortController | null = null;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;

function handleScroll(event: Event): void {
  if (!recordingEnabled) return;
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
