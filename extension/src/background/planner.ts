import { apiClient } from "./api";
import { createLogger } from "../shared/logger";
import type { RuntimeParams } from "../shared/types";

const log = createLogger("planner");

interface PlanResult {
  strategy: string;
  mode: string;
  steps?: Record<string, unknown>[];
  parameters?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  reason?: string;
}

export class ReplayPlanner {
  async getExecutionPlan(
    workflowId: string,
    runtimeParams?: RuntimeParams,
  ): Promise<PlanResult> {
    if (runtimeParams && Object.keys(runtimeParams).length > 0) {
      log.log(`Running with params: ${JSON.stringify(runtimeParams)}`);
      try {
        const result = await apiClient.runWithParams(workflowId, runtimeParams);
        if (result.execution_plan) {
          return result.execution_plan;
        }
        return { strategy: "literal", mode: "exact", reason: "No execution plan returned" };
      } catch (err) {
        log.error("run-with-params failed, falling back to literal:", err);
        return { strategy: "literal", mode: "exact", reason: "Parameterized run failed — fallback" };
      }
    }

    try {
      const analysis = await apiClient.getWorkflowAnalysis(workflowId);
      if (analysis?.replay_strategy === "parameterized" && analysis.parameters?.length > 0) {
        return {
          strategy: "parameterized",
          mode: "requires_params",
          parameters: Object.fromEntries(
            analysis.parameters.map((p: { key: string; default: unknown }) => [p.key, p.default ?? ""])
          ),
          reason: "Workflow has parameters but no runtime values provided — using defaults",
        };
      }
    } catch {
      log.log("No analysis available, using literal replay");
    }

    return { strategy: "literal", mode: "exact", reason: "Literal trace replay" };
  }

  async suggestStrategy(workflowId: string): Promise<string> {
    try {
      const analysis = await apiClient.getWorkflowAnalysis(workflowId);
      return analysis?.replay_strategy || "literal";
    } catch {
      return "literal";
    }
  }
}

export const replayPlanner = new ReplayPlanner();
