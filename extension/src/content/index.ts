import {
  captureClick,
  captureInput,
  captureScroll,
  type CaptureResult,
} from "./capture";
import { executeStep, captureDomSnippet, type StepToExecute, type StepResult } from "./replay";
import { detectChallenges } from "../background/detector";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

const STORAGE_KEY = "recording_state";

let recordingEnabled = false;
let eventCount = 0;

function sendDebugLog(level: string, msg: string): void {
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", level, message: msg, source: "content-script" }).catch(() => {});
}

sendDebugLog("log", "Content script loaded");

chrome.storage.session.get(STORAGE_KEY).then((data) => {
  const state = data[STORAGE_KEY] as { isRecording: boolean; events: unknown[] } | undefined;
  if (state?.isRecording) {
    recordingEnabled = true;
    eventCount = state.events?.length ?? 0;
    sendDebugLog("log", `Initial state: recording enabled (${eventCount} events)`);
  }
}).catch(() => {});

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

(window as any).__SR_CONTENT_SCRIPT__ = true;

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
        sendResponse({ type: "STEP_RESULT", ...executeStep((msg as BackgroundToContentMessage).step as StepToExecute) } as StepResult);
        break;
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
    }
    return true;
  },
);

// ── Event capture ──────────────────────────────────────────────────

function sendToBackground(event: CaptureResult): void {
  if (!recordingEnabled) return;

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

document.addEventListener("click", (e: MouseEvent) => {
  if (!recordingEnabled) return;
  if (e.defaultPrevented) return;
  sendToBackground(captureClick(e));
}, false);

document.addEventListener("change", (e: Event) => {
  if (!recordingEnabled) return;
  if (e.defaultPrevented) return;
  const target = e.target as HTMLElement;
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    sendToBackground(captureInput(e));
  }
}, false);

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
