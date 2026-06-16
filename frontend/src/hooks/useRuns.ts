import { useEffect } from "react";
import { useApi, useApiData } from "./useApi";

export interface RunOrigin {
  event_kind?: string;
  pipeline?: {
    job_id?: string;
    position?: string;
    project_name?: string;
  };
}

export interface RunSummary {
  id: string;
  workflow_id: string;
  status: string;
  current_step_index: number;
  total_steps: number;
  pause_reason?: string;
  error_summary?: string;
  created_at: string;
  origin?: RunOrigin | null;
}

// Human-readable stage per pipeline event_kind, so chained pipeline runs that
// belong to the same Odoo position read as one related group in the run list.
const PIPELINE_STAGE: Record<string, string> = {
  recruiter_create_project: "create project",
  recruiter_search: "search",
  recruiter_save: "save",
  recruiter_message: "message",
  new_job_position: "applicant scrape",
  linkedin_lead_search: "lead search",
};

/** Returns a "<position> · <stage>" label for a pipeline run, or null otherwise. */
export function pipelineLabel(origin?: RunOrigin | null): string | null {
  if (!origin) return null;
  const stage = origin.event_kind ? PIPELINE_STAGE[origin.event_kind] : undefined;
  if (!stage) return null;
  const position = origin.pipeline?.position?.trim();
  return position ? `${position} · ${stage}` : stage;
}

/** Stable group key (the Odoo job) so the UI can tell which runs belong together. */
export function pipelineJobId(origin?: RunOrigin | null): string | null {
  return origin?.pipeline?.job_id ? String(origin.pipeline.job_id) : null;
}

/** The LinkedIn project a pipeline run targets (the "-EZ <position>" name), or null. */
export function pipelineProjectName(origin?: RunOrigin | null): string | null {
  return origin?.pipeline?.project_name?.trim() || null;
}

export function useRuns(workflowId?: string) {
  const { data, loading, error, fetchData } = useApiData<RunSummary[]>();
  const { request } = useApi();
  const params = workflowId ? `?workflow_id=${workflowId}&limit=1000` : "?limit=1000";

  useEffect(() => {
    fetchData("GET", `/runs${params}`);
  }, [params, fetchData]);

  const cancelRun = async (runId: string) => {
    await request("POST", `/runs/${runId}/cancel`);
  };

  const deleteAllRuns = async () => {
    await request("DELETE", "/runs");
  };

  return {
    runs: data || [],
    loading,
    error,
    refetch: () => {
      fetchData("GET", `/runs${params}`);
    },
    cancelRun,
    deleteAllRuns,
  };
}
