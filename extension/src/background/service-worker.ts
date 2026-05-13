import { orchestrator } from "./orchestrator";
import { apiClient } from "./api";
import { createLogger } from "../shared/logger";
import { stepHealer } from "./healer";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
} from "../shared/messaging";

const log = createLogger("service-worker");

chrome.runtime.onInstalled.addListener(() => {
  log.log("Session Replay extension installed");
});

chrome.runtime.onMessage.addListener(
  (
    message:
      | ContentToBackgroundMessage
      | { type: string; [key: string]: unknown },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ) => {
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
        }).catch(() => {
          sendResponse({ type: "WORKFLOWS", workflows: [] });
        });
        return true;
      }
      case "RUN_WORKFLOW": {
        const msg = message as unknown as { workflowId: string; tabId?: number };
        const tabId = msg.tabId ?? sender.tab?.id;
        executeWorkflowRun(msg.workflowId, tabId)
          .then((result: { id: string; status: string; total_steps: number }) => {
            sendResponse({ type: "RUN_STARTED", run: result });
          })
          .catch((err: unknown) => {
            log.error("Failed to run workflow:", err);
            sendResponse({ type: "RUN_FAILED", error: String(err) });
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
            log.error("Failed to stop recording:", err);
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
        executeStepOnTab(msg.step, sender.tab?.id)
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
    }
  },
);

async function waitForTabLoad(tabId: number, timeoutMs: number = 15000): Promise<void> {
  // Check if tab is already complete (avoids race with onUpdated)
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
  } catch {
    // Tab may be gone
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Page load timed out")), timeoutMs);
    const listener = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (_tabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
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

  try {
    const response = await chrome.tabs.sendMessage(targetTabId, {
      type: "EXECUTE_STEP",
      step,
    } as BackgroundToContentMessage);
    return response as { success: boolean; error?: string };
  } catch (err) {
    return {
      success: false,
      error: "Content script not available on this page. Navigate to the target page first.",
    };
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

  // Pin the target tab — resolve once, use throughout
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tabs[0]?.id;
  }
  if (!targetTabId) {
    return { id: runId, status: "failed", total_steps: steps.length };
  }

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

  for (let i = 0; i < steps.length && allStepsSucceeded; i++) {
    const step = steps[i];
    const actionType = step.action_type;
    log.log(`Executing step ${i + 1}/${steps.length}: ${actionType}`);

    orchestrator.notifyRunning(workflow.name, i, steps.length, runId);

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

    const stepToExecute: BackgroundToContentMessage["step"] = {
      action_type: actionType,
      selector_chain: step.selector_chain || [],
      value: step.value,
      intent: step.intent,
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

    // Failure analysis
    if (actionType === "navigate") {
      // Navigate steps: failure only means invalid URL
      if (!result.success) {
        log.error(`Navigate step ${i + 1} failed: ${result.error}`);
        await reportStepFailure(runId, i, result.error || "Navigate failed", actionType);
        orchestrator.notifyFailed(workflow.name, i, steps.length, runId, result.error || "Navigate failed");
        allStepsSucceeded = false;
        break;
      }
      // Navigate always causes navigation — don't check urlChanged (too early)
      log.log(`Step ${i + 1} (navigate) completed`);
      try {
        await apiClient.reportStepResult(runId, i, true, undefined, actionType);
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

    // Small delay between steps
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Final navigation wait for last step
  if (pendingNavigation && allStepsSucceeded) {
    try {
      await waitForTabLoad(targetTabId);
    } catch {
      log.error("Final navigation load incomplete");
    }
  }

  if (allStepsSucceeded) {
    try {
      await apiClient.completeRun(runId);
      log.log(`Run ${runId} completed`);
    } catch (err) {
      log.error("Failed to complete run:", err);
    }
  }

  orchestrator.notifyIdle();
  orchestrator.broadcastState();

  return { id: runId, status: allStepsSucceeded ? "completed" : "failed", total_steps: steps.length };
}

chrome.alarms.create("keepAlive", { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    chrome.storage.session.get("keepAlive").catch(() => {});
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage?.();
});

// Expose for e2e testing
if (typeof self !== "undefined") {
  (self as unknown as Record<string, unknown>).__executeWorkflowRun = executeWorkflowRun;
}
