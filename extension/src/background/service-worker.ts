import { orchestrator, runTabMap, setRunTab, clearRunTab } from "./orchestrator";
import { apiClient } from "./api";
import { createLogger } from "../shared/logger";
import { stepHealer } from "./healer";
import { stepExecutor } from "./executor";
import { registerServiceWorkerListeners } from "./message-router";
import { commandExecutor } from "./command-executor";
import { waitForTabLoad, waitForTabLoadBestEffort } from "./tab-load";
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

function parseExtractFields(value: string): string[] {
  return value
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

function buildExtractSchema(fields: string[]): Record<string, unknown> {
  const properties: Record<string, { type: string }> = {};
  for (const f of fields) {
    const key = f.toLowerCase().replace(/[^a-z0-9]/g, "_");
    properties[key] = { type: "string" };
  }
  return { items: { properties } };
}

async function executeExtractStep(
  runId: string,
  stepIndex: number,
  step: { action_type: string; value?: string; intent?: string },
  targetTabId: number,
): Promise<void> {
  const fields = parseExtractFields(step.value || "");
  if (fields.length === 0) {
    log.log(`[Extract] Step ${stepIndex}: no fields specified, skipping`);
    await apiClient.reportStepResult(runId, stepIndex, true, undefined, "extract");
    return;
  }

  const schema = buildExtractSchema(fields);
  log.log(`[Extract] Step ${stepIndex}: fields=${fields.join(",")}`);

  const extraction = await stepExecutor.extractData(
    targetTabId,
    schema,
    stepIndex,
  );

  let data = extraction?.data || [];
  const missingFields = extraction?.missing_fields || [];

  // AI fallback: if heuristic extraction missed some fields, ask the AI
  if (missingFields.length > 0 && data.length > 0) {
    log.log(
      `[Extract] Step ${stepIndex}: ${missingFields.length} field(s) missing (${missingFields.join(", ")}), trying AI`,
    );
    try {
      let pageText: string | null = null;
      try {
        const ctx = await commandExecutor.captureContext(targetTabId);
        pageText = ctx.visible_text || ctx.dom_snippet || "";
      } catch {
        // context capture is best-effort
      }

      if (pageText) {
        const missingSchema: Record<string, unknown> = {
          properties: Object.fromEntries(
            missingFields.map((f) => [f, { type: "string" }]),
          ),
        };
        const aiResult = await apiClient.aiExtract(pageText, missingSchema);
        const aiData = aiResult.data as Record<string, unknown>;
        if (aiData && typeof aiData === "object" && !Array.isArray(aiData)) {
          // Merge AI results into the first record
          for (const [key, val] of Object.entries(aiData)) {
            if (val != null && !(key in data[0])) {
              data[0][key] = val;
            }
          }
          log.log(`[Extract] Step ${stepIndex}: AI filled ${Object.keys(aiData).length} field(s)`);
        }
      }
    } catch (err) {
      log.error(`[Extract] Step ${stepIndex}: AI fallback failed:`, err);
    }
  }

  if (data.length > 0) {
    await apiClient.reportExtraction(
      runId,
      stepIndex,
      data,
      extraction?.schema || schema,
    );
    log.log(`[Extract] Step ${stepIndex}: recorded ${data.length} record(s)`);
  } else {
    log.log(`[Extract] Step ${stepIndex}: no data extracted`);
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
      await new Promise((r) => setTimeout(r, stepDelay));
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
      | { action_type?: string; value?: string; intent?: string }
      | undefined;
    if (currentStep && currentStep.action_type === "extract") {
      log.log(`[Agent] Extract step ${currentStepIndex}: executing inline`);
      await executeExtractStep(
        runId,
        currentStepIndex,
        {
          action_type: "extract",
          value: currentStep.value,
          intent: currentStep.intent,
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
  canceledRuns.delete(runId);
  return { id: runId, status: finalStatus, total_steps: totalSteps };
}

registerServiceWorkerListeners({
  canceledRuns,
  sendOverlay,
  executeAgentRun,
  executeStepOnTab,
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
