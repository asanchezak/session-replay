import { apiClient } from "./api";
import { orchestrator } from "./orchestrator";
import type { BackgroundToContentMessage } from "../shared/messaging";
import type { RecordedStep, SemanticWorkflowInfo, ExtractedData } from "../shared/types";
import { createLogger } from "../shared/logger";

const log = createLogger("executor");

export interface ExtendedStep extends RecordedStep {
  _substituted?: boolean;
  _param_key?: string;
}

export class StepExecutor {
  async executeStep(
    runId: string,
    step: ExtendedStep,
    tabId: number,
    workflowName: string,
    totalSteps: number,
  ): Promise<{ success: boolean; error?: string }> {
    const bgStep: BackgroundToContentMessage = {
      type: "EXECUTE_STEP",
      step: {
        action_type: step.action_type,
        selector_chain: step.selector_chain?.map((s) => ({ type: s.type, value: s.value })) || [],
        value: step.value,
        intent: step.intent,
        methods: step.methods?.map((m) => ({
          action_type: m.action_type,
          selector_chain: m.selector_chain.map((s) => ({ type: s.type, value: s.value })),
          value: m.value,
        })),
      },
    };

    try {
      const response = await chrome.tabs.sendMessage(tabId, bgStep);
      const result = response as { type: string; success: boolean; error?: string };
      if (result.type === "STEP_RESULT") {
        return { success: result.success, error: result.error };
      }
      return { success: false, error: "Unexpected response from content script" };
    } catch (err) {
      log.error(`Step ${step.step_index}/${totalSteps} execution error:`, err);
      return { success: false, error: String(err) };
    }
  }

  async extractData(
    tabId: number,
    outputSchema: Record<string, unknown> | null,
    stepIndex: number,
  ): Promise<ExtractedData | null> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_DATA",
        outputSchema,
      });
      const result = response as {
        type: string;
        data: Record<string, unknown>[];
        url: string;
        error?: string;
      };

      if (result.type === "EXTRACT_DATA_RESULT" && !result.error) {
        return {
          step_index: stepIndex,
          data: result.data,
          schema: outputSchema,
          url: result.url,
          timestamp: new Date().toISOString(),
        };
      }
      return null;
    } catch (err) {
      log.error(`Data extraction failed at step ${stepIndex}:`, err);
      return null;
    }
  }
}

export const stepExecutor = new StepExecutor();
