import { apiClient } from "./api";
import { orchestrator } from "./orchestrator";
import { createLogger } from "../shared/logger";
import type { BackgroundToContentMessage } from "../shared/messaging";

const log = createLogger("healer");

export interface HealResult {
  success: boolean;
  newSelectors?: Array<{ type: string; value: string }>;
  error?: string;
}

export class StepHealer {
  async heal(
    runId: string,
    stepIndex: number,
    step: BackgroundToContentMessage["step"],
    tabId: number,
    workflowName: string = "",
    totalSteps: number = 0,
  ): Promise<HealResult> {
    log.log(`Healing step ${stepIndex} (${step.action_type}) for run ${runId}`);

    // 1. Try capturing DOM context
    let domSnippet = "";
    let domError: string | undefined;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CAPTURE_DOM_SNIPPET",
        selectorPattern: step.selector_chain[0]?.value || "",
      });
      const result = response as { type: string; html: string; url: string; error?: string };
      if (result.type === "DOM_SNIPPET_RESULT") {
        domSnippet = result.html;
        domError = result.error;
      }
    } catch (err) {
      domError = "Content script not available for DOM capture";
      log.error(domError);
    }

    // 2. Broadcast recovering state to popup
    orchestrator.notifyRecovering(workflowName, stepIndex, totalSteps, runId, domError || "Step failed");

    // 3. Transition to RECOVERING
    try {
      await apiClient.recoverRun(runId, stepIndex, domError || "Step failed");
    } catch (err) {
      log.error("Failed to transition to recovering:", err);
      return { success: false, error: "Failed to enter recovery state" };
    }

    // 4. Try fallback methods
    if (step.methods && step.methods.length > 0) {
      log.log(`Trying ${step.methods.length} fallback methods`);
      for (const method of step.methods) {
        try {
          const methodStep: BackgroundToContentMessage["step"] = {
            action_type: method.action_type,
            selector_chain: method.selector_chain,
            value: method.value,
          };
          const methodResult = await chrome.tabs.sendMessage(tabId, {
            type: "EXECUTE_STEP",
            step: methodStep,
          } as BackgroundToContentMessage);
          const res = methodResult as { success: boolean; error?: string };
          if (res.success) {
            log.log(`Fallback method succeeded: ${method.action_type}`);
            return { success: true, newSelectors: method.selector_chain };
          }
        } catch {
          continue;
        }
      }
    }

    // 5. Try AI healing
    if (domSnippet && domSnippet.length > 50) {
      log.log("Attempting AI healing");
      try {
        const oldSelectors = step.selector_chain.map((s) => s.value);
        const intent = (step as any).intent || step.value || "";
        const healResponse = await apiClient.healStep(
          runId, stepIndex, domSnippet, oldSelectors, intent,
        );

        if (healResponse.new_selectors && healResponse.new_selectors.length > 0 && healResponse.confidence > 0.3) {
          log.log(`AI suggested ${healResponse.new_selectors.length} new selectors (confidence: ${healResponse.confidence})`);

          const aiStep: BackgroundToContentMessage["step"] = {
            ...step,
            selector_chain: healResponse.new_selectors,
          };
          try {
            const aiResult = await chrome.tabs.sendMessage(tabId, {
              type: "EXECUTE_STEP",
              step: aiStep,
            } as BackgroundToContentMessage);
            const res = aiResult as { success: boolean; error?: string };
            if (res.success) {
              log.log(`AI healing succeeded with selector: ${healResponse.new_selectors[0]?.value}`);
              return { success: true, newSelectors: healResponse.new_selectors };
            }
          } catch {
            log.error("AI selector failed during execution");
          }
        }
      } catch (err) {
        log.error("AI healing request failed:", err);
      }
    }

    log.log("All healing attempts failed");
    return { success: false, error: domError || "Element not found" };
  }
}

export const stepHealer = new StepHealer();
