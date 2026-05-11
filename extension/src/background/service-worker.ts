import { orchestrator } from "./orchestrator";
import { apiClient } from "./api";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";
import type { PopupState } from "../shared/types";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Session Replay extension installed");
});

chrome.runtime.onMessage.addListener(
  (
    message:
      | ContentToBackgroundMessage
      | { type: string; [key: string]: unknown },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
    switch (message.type) {
      case "RECORD_EVENT": {
        const msg = message as ContentToBackgroundMessage;
        orchestrator
          .pushEvent(msg.event)
          .then(() => {
            sendResponse({ type: "EVENT_RECORDED", id: "buffered", hash: "" });
          })
          .catch((err) => {
            console.error("Failed to record event:", err);
            sendResponse({ type: "EVENT_RECORDED", id: "", hash: "" });
          });
        return true;
      }

      case "START_RECORDING":
        orchestrator.startRecording();
        sendResponse({ type: "RECORDING_STARTED" });
        break;

      case "STOP_RECORDING":
        orchestrator
          .stopRecording()
          .then(() => {
            sendResponse({ type: "RECORDING_STOPPED" });
          })
          .catch((err) => {
            console.error("Failed to stop recording:", err);
            sendResponse({ type: "RECORDING_STOPPED" });
          });
        return true;

      case "RESUME_RUN":
        sendResponse({ type: "RUN_RESUMED" });
        break;

      case "GET_STATE":
        sendResponse({ type: "STATE", state: orchestrator.getState() });
        break;

      case "EXECUTE_STEP": {
        const msg = message as unknown as BackgroundToContentMessage;
        sendResponse({ type: "STEP_RESULT", success: false, error: "Not implemented" });
        return true;
      }
    }
  },
);

chrome.alarms.create("keepAlive", { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    chrome.storage.session.get("keepAlive").catch(() => {
      // Service worker is alive
    });
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage?.();
});
