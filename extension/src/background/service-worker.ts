import { orchestrator } from "./orchestrator";
import { apiClient, DEV_DEFAULTS } from "./api";
import { createLogger } from "../shared/logger";
import { stepHealer } from "./healer";
import { stepExecutor } from "./executor";
import { commandExecutor } from "./command-executor";
import { detectChallenges } from "../shared/detector";
import type { ChallengeDetection } from "../shared/detector";
import type {
  ContentToBackgroundMessage,
  BackgroundToContentMessage,
  DetectChallengesMessage,
  ChallengesDetectedResponse,
} from "../shared/messaging";
import type { AgentDecision, AgentCommand, PageContext } from "../shared/types";

const log = createLogger("service-worker");

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
        const msg = message as unknown as { workflowId: string; tabId?: number };
        const tabId = msg.tabId ?? sender.tab?.id;
        executeAgentRun(msg.workflowId, tabId)
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

      default:
        sendResponse({ type: "ERROR", code: "UNKNOWN_MESSAGE", received: message.type });
        break;
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
    function cleanup(): void {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Page load timed out"));
    }, timeoutMs);
    const listener = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (_tabId === tabId && changeInfo.status === "complete") {
        cleanup();
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

    const stepToExecute: BackgroundToContentMessage["step"] = {
      action_type: actionType,
      selector_chain: step.selector_chain || [],
      value: step.value,
      intent: step.intent,
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
    await new Promise((r) => setTimeout(r, stepDelay));
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

    // Attempt data extraction after successful run
    if (targetTabId) {
      try {
        const outputSchema = typeof (workflow as Record<string, unknown>).output_spec === "object"
          ? (workflow as Record<string, unknown>).output_spec as Record<string, unknown> | null
          : null;
        const extraction = await stepExecutor.extractData(
          targetTabId,
          outputSchema as Record<string, unknown> | null,
          steps.length,
        );
        if (extraction && extraction.data.length > 0) {
          await apiClient.reportExtraction(runId, extraction.step_index, extraction.data);
          log.log(`Extracted ${extraction.data.length} records from run ${runId}`);
        }
      } catch (err) {
        log.error("Data extraction failed:", err);
      }
    }
  }

  orchestrator.notifyIdle();
  orchestrator.broadcastState();

  return { id: runId, status: statusOverride || (allStepsSucceeded ? "completed" : "failed"), total_steps: steps.length };
}

async function executeAgentRun(
  workflowId: string,
  tabId?: number,
): Promise<{ id: string; status: string; total_steps: number }> {
  const run = await apiClient.runWorkflow(workflowId);
  const runId = run.id;
  log.log(`[Agent] Run ${runId} started for workflow ${workflowId}`);

  const workflow = await apiClient.getWorkflow(workflowId);
  // Mutable, loosely-typed steps array so plan_updates can INSERT/REMOVE/MODIFY
  // arbitrary shapes mid-run. We rely on the backend snapshot as the source of
  // truth for execution; this local cache only feeds the HEAL fallback.
  const steps: Array<Record<string, unknown>> = (workflow.steps || []).map(
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

  let currentStepIndex = 0;
  let pollCount = 0;
  let finalStatus = "completed";
  // Phase 3: when the backend says PAUSE, don't bail immediately — re-poll
  // for up to `pauseRePollCap * 10s` ≈ 5 minutes so the auto-recovery
  // supervisor can produce a fresh decision. After the cap, surface
  // waiting_for_user.
  let pausePollCount = 0;
  const pauseRePollCap = 30;

  while (true) {
    pollCount++;

    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      log.error("[Agent] Target tab closed");
      await apiClient.failRun(runId, "Target tab closed");
      orchestrator.notifyFailed(workflow.name, currentStepIndex, totalSteps, runId, "Target tab closed");
      finalStatus = "failed";
      break;
    }

    const pageContext = await commandExecutor.captureContext(targetTabId);

    if (pageContext.is_blocking) {
      log.log(`[Agent] Blocking challenge: ${pageContext.blocking_type}`);
      await apiClient.pauseRun(runId, `Blocking: ${pageContext.blocking_type}`, currentStepIndex);
      orchestrator.notifyWaiting(runId, `Blocking: ${pageContext.blocking_type}`);
      finalStatus = "waiting_for_user";
      break;
    }

    log.log(`[Agent] Poll #${pollCount} step ${currentStepIndex}/${totalSteps}`);
    const pollResponse = await apiClient.agentPoll(runId, {
      page_context: pageContext,
      current_step_index: currentStepIndex,
    });

    log.log(
      `[Agent] Decision: ${pollResponse.decision} ` +
      `(conf: ${pollResponse.confidence})`,
    );

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

        if (cmd.action === "navigate") {
          const url = cmd.value || cmd.target;
          if (url) {
            await chrome.tabs.update(targetTabId, { url });
            await waitForTabLoad(targetTabId);
          }
          await apiClient.agentResult(runId, {
            step_index: currentStepIndex,
            success: true,
            error: null,
            page_context_after: null,
          });
          currentStepIndex++;
        } else {
          const execResult = await commandExecutor.executeCommand(
            targetTabId, cmd,
          );

          if (execResult.success) {
            log.log(`[Agent] Step ${currentStepIndex} OK`);
          } else {
            log.error(`[Agent] Step ${currentStepIndex} failed: ${execResult.error}`);
          }

          let errorContext = "";
          if (!execResult.success && targetTabId) {
            try {
              const ctx = await commandExecutor.captureContext(targetTabId);
              errorContext = ctx.dom_snippet || ctx.visible_text || "";
            } catch {
              // context capture best-effort
            }
          }

          const resultResponse = await apiClient.agentResult(runId, {
            step_index: currentStepIndex,
            success: execResult.success,
            error: execResult.error || null,
            page_context_after: null,
            error_context: errorContext || undefined,
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
          if (next === "PAUSE") {
            orchestrator.notifyWaiting(
              runId,
              execResult.error || "Step failed repeatedly",
            );
            finalStatus = "waiting_for_user";
            break;
          }
          if (next === "RETRY") {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          if (next === "ADAPT") {
            const analysis = resultResponse.ai_analysis as
              | {
                  suggested_selectors?: Array<{ type: string; value: string; score?: number }>;
                  suggested_action?: string;
                  suggested_value?: string;
                }
              | undefined;
            const suggestedAction = analysis?.suggested_action;
            const suggestedValue = analysis?.suggested_value;
            const adaptedCommand = analysis?.suggested_selectors;
            const recordedStep = steps[currentStepIndex] as Record<string, unknown>;

            if (suggestedAction === "navigate" && suggestedValue) {
              log.log(`[Agent] Adapting step ${currentStepIndex}: navigate -> ${suggestedValue}`);
              try {
                await chrome.tabs.update(targetTabId, { url: suggestedValue });
                await waitForTabLoad(targetTabId);
                await apiClient.agentResult(runId, {
                  step_index: currentStepIndex,
                  success: true,
                  error: null,
                  page_context_after: null,
                });
                currentStepIndex++;
              } catch (err) {
                log.error(`[Agent] Adapted navigate failed: ${err}`);
              }
              continue;
            }

            if (adaptedCommand && adaptedCommand.length > 0) {
              const action = (suggestedAction as "navigate" | "click" | "type" | "select" | "scroll" | "extract")
                || (recordedStep.action_type as "navigate" | "click" | "type" | "select" | "scroll" | "extract")
                || "click";
              const value = suggestedValue ?? (recordedStep.value as string | null) ?? null;
              log.log(`[Agent] Adapting step ${currentStepIndex} (action=${action}) with AI-suggested selectors`);
              const adaptResult = await commandExecutor.executeCommand(
                targetTabId,
                {
                  action,
                  target: value,
                  value,
                  selector_chain: adaptedCommand,
                  intent: (recordedStep.intent as string | null) || null,
                  methods: [],
                  timeout_ms: 15000,
                  success_condition: null,
                },
              );
              await apiClient.agentResult(runId, {
                step_index: currentStepIndex,
                success: adaptResult.success,
                error: adaptResult.error || null,
                page_context_after: null,
              });
              if (adaptResult.success) {
                log.log(`[Agent] Adapted step ${currentStepIndex} succeeded`);
                currentStepIndex++;
              } else {
                log.error(`[Agent] Adapted step ${currentStepIndex} still failed: ${adaptResult.error}`);
              }
            } else {
              log.log("[Agent] ADAPT decision but no suggested selectors/action, re-polling");
            }
            continue;
          }
          if (next === "SKIP") {
            log.log(`[Agent] AI recommends skipping step ${currentStepIndex}`);
            currentStepIndex = resultResponse.next_step_index ?? currentStepIndex + 1;
            continue;
          }
          if (next === "HEAL") {
            const healed = await tryHealStep(
              runId, currentStepIndex, steps[currentStepIndex],
              targetTabId, workflow.name, totalSteps,
            );
            await apiClient.agentResult(runId, {
              step_index: currentStepIndex,
              success: healed,
              error: healed ? null : "Healing exhausted",
              page_context_after: null,
            });
            if (healed) {
              currentStepIndex++;
            }
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

    if (finalStatus !== "completed") break;

    await new Promise((r) => setTimeout(r, 200));
  }

  orchestrator.notifyIdle();
  orchestrator.broadcastState();
  return { id: runId, status: finalStatus, total_steps: totalSteps };
}

async function tryHealStep(
  runId: string,
  stepIndex: number,
  snapshotStep: Record<string, unknown>,
  tabId: number,
  workflowName: string,
  totalSteps: number,
): Promise<boolean> {
  const actionType = snapshotStep.action_type as string;
  const selectorChain = (snapshotStep.selector_chain || []) as Array<{ type: string; value: string }>;
  const value = snapshotStep.value as string | undefined;
  const intent = snapshotStep.intent as string | undefined;
  const methods = snapshotStep.methods as Array<{
    action_type: string;
    selector_chain: Array<{ type: string; value: string }>;
    value?: string;
  }> | undefined;

  const stepForExecution = {
    action_type: actionType,
    selector_chain: selectorChain,
    value,
    intent,
  };

  // 1. Try fallback methods first (fast, no API calls)
  if (methods && methods.length > 0) {
    log.log(`[Agent] Trying ${methods.length} fallback methods`);
    orchestrator.notifyRecovering(workflowName, stepIndex, totalSteps, runId, "Trying fallback methods");
    for (const method of methods) {
      try {
        const methodCmd = {
          action: method.action_type as "navigate" | "click" | "type" | "select" | "scroll" | "extract",
          target: null,
          value: method.value || null,
          selector_chain: method.selector_chain,
          intent: null,
          methods: [],
          timeout_ms: 15000,
          success_condition: null,
        };
        const result = await commandExecutor.executeCommand(tabId, methodCmd);
        if (result.success) {
          log.log(`[Agent] Fallback method succeeded: ${method.action_type}`);
          return true;
        }
      } catch {
        continue;
      }
    }
  }

  // 2. Try AI healing
  let domSnippet = "";
  let pageUrl = "";
  let visibleText = "";
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "CAPTURE_DOM_SNIPPET",
      selectorPattern: selectorChain[0]?.value || "",
    });
    const domResult = response as { type: string; html: string; url: string; error?: string };
    if (domResult.type === "DOM_SNIPPET_RESULT") {
      domSnippet = domResult.html;
      pageUrl = domResult.url || "";
    }
  } catch {
    log.error("[Agent] DOM capture failed for healing");
  }

  try {
    const ctxResponse = await commandExecutor.captureContext(tabId);
    visibleText = ctxResponse.visible_text || "";
    if (!pageUrl) pageUrl = ctxResponse.url || "";
  } catch {
    // context capture best-effort
  }

  if (domSnippet && domSnippet.length > 50) {
    log.log("[Agent] Attempting AI healing");
    orchestrator.notifyRecovering(workflowName, stepIndex, totalSteps, runId, "AI healing");
    try {
      const oldSelectors = selectorChain.map((s) => s.value);
      const healIntent = intent || value || "";
      const healResponse = await apiClient.healStep(
        runId, stepIndex, domSnippet, oldSelectors, healIntent,
        visibleText, pageUrl,
      );

      if (healResponse.new_selectors && healResponse.new_selectors.length > 0) {
        log.log(
          `[Agent] AI suggested ${healResponse.new_selectors.length} selectors ` +
          `(confidence: ${healResponse.confidence})`,
        );
        if (healResponse.confidence > 0.5) {
          const aiCmd = {
            action: actionType as "navigate" | "click" | "type" | "select" | "scroll" | "extract",
            target: null,
            value: value || null,
            selector_chain: healResponse.new_selectors,
            intent: intent || null,
            methods: [],
            timeout_ms: 15000,
            success_condition: null,
          };
          const aiResult = await commandExecutor.executeCommand(tabId, aiCmd);
          if (aiResult.success) {
            log.log(`[Agent] AI healing succeeded`);
            return true;
          }
          log.error(`[Agent] AI selector execution failed: ${aiResult.error}`);
        } else {
          log.log(`[Agent] AI confidence too low: ${healResponse.confidence}`);
        }
      }
    } catch (err) {
      log.error("[Agent] AI healing request failed:", err);
    }
  }

  log.log("[Agent] All healing attempts exhausted");
  return false;
}

chrome.runtime.onMessageExternal.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    const msg = message as { type: string; workflowId?: string; tabId?: number };
    if (msg.type === "RUN_WORKFLOW" && msg.workflowId) {
      log.log(`[External] RUN_WORKFLOW for ${msg.workflowId}`);
      executeAgentRun(msg.workflowId, msg.tabId)
        .then((result) => sendResponse({ type: "RUN_STARTED", run: result }))
        .catch((err) => sendResponse({ type: "RUN_FAILED", error: String(err) }));
      return true;
    }
    sendResponse({ type: "ERROR", code: "UNKNOWN_MESSAGE" });
  },
);

chrome.alarms.create("keepAlive", { periodInMinutes: 4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    fetch("http://localhost:8081/v1/health").catch(() => {});
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage?.();
});

// Expose for e2e testing
if (typeof self !== "undefined") {
  const g = self as unknown as Record<string, unknown>;
  g.__executeWorkflowRun = executeWorkflowRun;
  g.__SR_startRecording = () => orchestrator.startRecording();
  g.__SR_stopRecording = () => orchestrator.stopRecording();
}

export { detectChallenges };
