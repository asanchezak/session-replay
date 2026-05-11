import {
  captureClick,
  captureInput,
  captureScroll,
  type CaptureResult,
} from "./capture";
import { executeStep, type StepToExecute, type StepResult } from "./replay";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

let recordingEnabled = false;

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundToContentMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (message.type) {
      case "EXECUTE_STEP":
        const result = executeStep(message.step as StepToExecute);
        sendResponse({ type: "STEP_RESULT", ...result } as StepResult);
        break;
    }
    return true;
  },
);

function sendToBackground(event: CaptureResult): void {
  if (!recordingEnabled) return;

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
    message: { type: string; enabled?: boolean },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { success: boolean }) => void,
  ) => {
    if (message.type === "SET_RECORDING") {
      recordingEnabled = message.enabled ?? false;
      sendResponse({ success: true });
    }
    return true;
  },
);
