import { orchestrator, runTabMap, clearRunTab } from "./orchestrator";
import { apiClient, DEV_DEFAULTS } from "./api";
import { createLogger } from "../shared/logger";
import { API_BASE_URL, DASHBOARD_ORIGIN } from "../shared/constants";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

const log = createLogger("service-worker");

type RunHandle = { id: string; status: string; total_steps: number };

type RouterDeps = {
  canceledRuns: Set<string>;
  sendOverlay: (
    tabId: number,
    payload: { step: number; total: number; action_type: string; workflow_name: string } | null,
  ) => void;
  executeAgentRun: (
    workflowId: string,
    tabId?: number,
    goal?: string,
    runtimeParams?: Record<string, unknown>,
    onStart?: (runHandle: RunHandle) => void,
  ) => Promise<RunHandle>;
  executeStepOnTab: (
    step: BackgroundToContentMessage["step"],
    tabId?: number,
  ) => Promise<{ success: boolean; [key: string]: unknown }>;
};

export function registerServiceWorkerListeners(deps: RouterDeps): void {
  chrome.runtime.onInstalled.addListener(() => {
    log.log("Session Replay extension installed");
    chrome.storage.session.get(["apiBaseUrl", "apiKey"]).then((stored) => {
      if (!stored.apiBaseUrl || !stored.apiKey) {
        chrome.storage.session.set({
          apiBaseUrl: DEV_DEFAULTS.apiBase,
          apiKey: DEV_DEFAULTS.apiKey,
        });
        log.log("Seeded default API config into session storage");
      }
    });
  });

  chrome.runtime.onMessage.addListener(
    (
      message:
        | ContentToBackgroundMessage
        | { type: string; [key: string]: unknown },
      sender: chrome.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      if (
        "protocol_version" in message &&
        message.protocol_version !== undefined &&
        message.protocol_version !== 1
      ) {
        sendResponse({ type: "ERROR", code: "UNSUPPORTED_PROTOCOL_VERSION", received: message.protocol_version });
        return;
      }

      switch (message.type) {
        case "DEBUG_LOG": {
          const m = message as unknown as { level: string; message: string; source?: string };
          log.log(`[${m.source || "content"}] ${m.message}`);
          sendResponse({ type: "DEBUG_LOG_ACK" });
          break;
        }
        case "FETCH_WORKFLOWS": {
          apiClient.listWorkflows().then((workflows) => {
            sendResponse({ type: "WORKFLOWS", workflows });
          }).catch((err) => {
            sendResponse({ type: "WORKFLOWS_ERROR", error: err instanceof Error ? err.message : String(err) });
          });
          return true;
        }
        case "RUN_WORKFLOW": {
          const msg = message as unknown as {
            workflowId: string;
            tabId?: number;
            goal?: string;
            params?: Record<string, unknown>;
          };
          const tabId = msg.tabId ?? sender.tab?.id;
          let responded = false;
          deps.executeAgentRun(msg.workflowId, tabId, msg.goal, msg.params, (runHandle) => {
            if (!responded) {
              responded = true;
              sendResponse({ type: "RUN_STARTED", run: runHandle });
            }
          }).catch((err: unknown) => {
            log.error("Failed to run workflow:", err);
            if (!responded) {
              responded = true;
              sendResponse({ type: "RUN_FAILED", error: String(err) });
            }
          });
          return true;
        }
        case "RECORD_EVENT": {
          const msg = message as ContentToBackgroundMessage;
          orchestrator
            .pushEvent(msg.event)
            .then(() => {
              sendResponse({ type: "EVENT_RECORDED", id: "buffered", hash: "" });
            })
            .catch((err) => {
              log.error("Failed to record event:", err);
              sendResponse({ type: "EVENT_RECORDED", id: "", hash: "" });
            });
          return true;
        }
        case "START_RECORDING":
          orchestrator.startRecording()
            .then(() => sendResponse({ type: "RECORDING_STARTED" }))
            .catch((err: unknown) => sendResponse({ type: "ERROR", message: String(err) }));
          return true;
        case "SET_RECORDING_GOAL": {
          const goal = (message as Record<string, unknown>).goal as string || "";
          orchestrator.setRecordingGoal(goal);
          sendResponse({ type: "GOAL_SET" });
          break;
        }
        case "STOP_RECORDING":
          orchestrator
            .stopRecording()
            .then(() => {
              sendResponse({ type: "RECORDING_STOPPED" });
            })
            .catch((err) => {
              log.error("Failed to stop recording:", err);
              sendResponse({ type: "RECORDING_STOPPED" });
            });
          return true;
        case "ADD_EXTRACT_STEP": {
          const payload = message as unknown as { fields: string; pageUrl?: string; pageTitle?: string; timestamp?: string };
          const event = {
            event_type: "extract" as const,
            payload: { value: payload.fields },
            page_url: payload.pageUrl || "",
            page_title: payload.pageTitle || "",
            timestamp: payload.timestamp || new Date().toISOString(),
          };
          orchestrator
            .pushEvent(event)
            .then(() => sendResponse({ type: "EVENT_RECORDED", id: "extract", hash: "" }))
            .catch((err: unknown) => sendResponse({ type: "ERROR", message: String(err) }));
          return true;
        }
        case "SELECTION_INTENT": {
          const payload = message as unknown as {
            selected_text: string;
            container_text: string;
            page_url?: string;
            page_title?: string;
            container_selector?: string;
            timestamp?: string;
          };
          const event = {
            event_type: "extract" as const,
            payload: {
              value: payload.selected_text,
              dom_context: {
                selected_text: payload.selected_text,
                container_text: payload.container_text,
                page_url: payload.page_url || "",
                container_selector: payload.container_selector || "",
              },
            },
            page_url: payload.page_url || "",
            page_title: payload.page_title || "",
            timestamp: payload.timestamp || new Date().toISOString(),
          };
          orchestrator
            .pushEvent(event)
            .then(() => sendResponse({ type: "EVENT_RECORDED", id: "selection_intent", hash: "" }))
            .catch((err: unknown) => sendResponse({ type: "ERROR", message: String(err) }));
          return true;
        }
        case "RESUME_RUN":
          sendResponse({ type: "RUN_RESUMED" });
          break;
        case "CANCEL_RUN": {
          const runId = (message as { runId?: string }).runId;
          if (runId) {
            deps.canceledRuns.add(runId);
            const tabId = runTabMap.get(runId);
            apiClient.cancelRun(runId).catch(() => {});
            if (tabId) deps.sendOverlay(tabId, null);
            orchestrator.notifyIdle();
          }
          sendResponse({ ok: true });
          break;
        }
        case "GET_STATE":
          sendResponse({ type: "STATE", state: orchestrator.getState() });
          break;
        case "EXECUTE_STEP": {
          const msg = message as unknown as BackgroundToContentMessage;
          deps.executeStepOnTab(msg.step, sender.tab?.id)
            .then((result) => {
              sendResponse({ type: "STEP_RESULT", ...result });
            })
            .catch((err) => {
              sendResponse({
                type: "STEP_RESULT",
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          return true;
        }
        default:
          sendResponse({ type: "ERROR", code: "UNKNOWN_MESSAGE", received: message.type });
          break;
      }
    },
  );

  chrome.runtime.onMessageExternal.addListener(
    (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
      const msg = message as {
        type: string;
        workflowId?: string;
        tabId?: number;
        goal?: string;
        params?: Record<string, unknown>;
      };
      if (msg.type === "RUN_WORKFLOW" && msg.workflowId) {
        log.log(`[External] RUN_WORKFLOW for ${msg.workflowId}`);
        let responded = false;
        deps.executeAgentRun(msg.workflowId, msg.tabId, msg.goal, msg.params, (runHandle) => {
          if (!responded) {
            responded = true;
            sendResponse({ type: "RUN_STARTED", run: runHandle });
          }
        }).catch((err) => {
          if (!responded) {
            responded = true;
            sendResponse({ type: "RUN_FAILED", error: String(err) });
          } else {
            log.error("[External] RUN_WORKFLOW loop failed after start:", err);
          }
        });
        return true;
      }
      sendResponse({ type: "ERROR", code: "UNKNOWN_MESSAGE" });
    },
  );

  chrome.alarms.create("keepAlive", { periodInMinutes: 4 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepAlive") {
      Promise.allSettled([
        fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(3000) }),
        fetch(DASHBOARD_ORIGIN, { method: "HEAD", signal: AbortSignal.timeout(3000) }),
      ]).then(([be, dash]) => {
        chrome.storage.session.set({
          connStatus: {
            backend: be.status === "fulfilled" && be.value.ok ? "up" : "down",
            dashboard: dash.status === "fulfilled" ? "up" : "down",
            checkedAt: Date.now(),
          },
        });
      });
    }
  });

  const recentNavigateUrls = new Map<number, string>();
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    if (!orchestrator.isRecording) return;
    const url = tab.url || "";
    if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url === "about:blank") return;
    if (recentNavigateUrls.get(tabId) === url) return;
    recentNavigateUrls.set(tabId, url);
    orchestrator.pushEvent({
      event_type: "navigate",
      payload: {
        target: {},
        intent: `Navigate to ${url}`,
        value: url,
      },
      page_url: url,
      page_title: tab.title || "",
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  });

  chrome.tabs.onRemoved.addListener((tabId: number) => {
    for (const [runId, trackedTabId] of runTabMap.entries()) {
      if (trackedTabId === tabId) {
        log.log(`[TabLifecycle] Tab ${tabId} closed for run ${runId} — notifying backend`);
        apiClient.reportTabClosed(runId).catch((err) => {
          log.error(`[TabLifecycle] Failed to report tab closed for run ${runId}:`, err);
        });
        clearRunTab(runId);
      }
    }
  });

  chrome.action.onClicked.addListener((tab) => {
    if (tab.id) {
      chrome.sidePanel?.open?.({ tabId: tab.id }).catch(() => {});
    }
  });
}
