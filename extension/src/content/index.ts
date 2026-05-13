import {
  captureClick,
  captureInput,
  captureScroll,
  type CaptureResult,
} from "./capture";
import { executeStep, captureDomSnippet, type StepToExecute, type StepResult } from "./replay";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

let recordingEnabled = false;
let eventCount = 0;

function sendDebugLog(level: string, msg: string): void {
  // Send via background SW to avoid CSP blocks on the host page
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", level, message: msg, source: "content-script" }).catch(() => {});
}

sendDebugLog("log", "Content script loaded");

// Read initial recording state from storage (survives page navigation)
chrome.storage.session.get("recording_state").then((data) => {
  const state = data.recording_state as { isRecording: boolean; events: unknown[] } | undefined;
  if (state?.isRecording) {
    recordingEnabled = true;
    eventCount = state.events?.length ?? 0;
    sendDebugLog("log", `Initial state: recording enabled (${eventCount} events)`);
  }
}).catch(() => {});

// React to recording state changes directly from storage (no message race)
// This replaces the SET_RECORDING message as the primary mechanism
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.recording_state) {
    const state = changes.recording_state.newValue;
    recordingEnabled = state?.isRecording ?? false;
    eventCount = state?.events?.length ?? 0;
    sendDebugLog("log", `Storage: recording ${recordingEnabled ? "enabled" : "disabled"} (${eventCount} events)`);
  }
});

// Flag for Playwright tests to verify content script is injected
(window as any).__SR_CONTENT_SCRIPT__ = true;

// ── Shadow DOM Replay UI ──────────────────────────────────────────
// Injects a replay progress panel into the page using Shadow DOM for
// complete CSS isolation from the host page.

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

export function showReplayPanel(step: number, total: number, status: string): void {
  if (!shadowHost) {
    shadowHost = document.createElement("div");
    shadowHost.id = "sr-replay-panel";
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: "closed" });
  }
  if (!shadowRoot) return;

  const pct = total > 0 ? Math.round((step / total) * 100) : 0;
  shadowRoot.innerHTML = `
    <style>${SHADOW_STYLES}</style>
    <div class="sr-panel">
      <div class="step">Step ${step}/${total}</div>
      <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="status">${status}</div>
    </div>
  `;
}

export function hideReplayPanel(): void {
  if (shadowHost && shadowHost.parentNode) {
    shadowHost.parentNode.removeChild(shadowHost);
  }
  shadowHost = null;
  shadowRoot = null;
}

chrome.runtime.onMessage.addListener(
  (
    msg: BackgroundToContentMessage | { type: string; step?: BackgroundToContentMessage["step"]; selectorPattern?: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (msg.type) {
      case "EXECUTE_STEP":
        const result = executeStep(msg.step as StepToExecute);
        sendResponse({ type: "STEP_RESULT", ...result } as StepResult);
        break;
      case "CAPTURE_DOM_SNIPPET":
        const snippet = captureDomSnippet(msg.selectorPattern || "");
        sendResponse({ type: "DOM_SNIPPET_RESULT", ...snippet });
        break;
    }
    return true;
  },
);

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

let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
document.addEventListener("scroll", () => {
  if (!recordingEnabled) return;
  if (scrollTimeout) clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => {
    sendToBackground(captureScroll());
  }, 500);
}, false);

chrome.runtime.onMessage.addListener(
  (
    msg2: { type: string; enabled?: boolean },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { success: boolean }) => void,
  ) => {
    if (msg2.type === "SET_RECORDING") {
      recordingEnabled = msg2.enabled ?? false;
      eventCount = 0;
      sendDebugLog("log", `Recording ${recordingEnabled ? "enabled" : "disabled"}`);
      sendResponse({ success: true });
    }
    return true;
  },
);
