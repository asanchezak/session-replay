import { useEffect } from "react";
import { useApi, useApiData } from "./useApi";

export interface RunSummary {
  id: string;
  workflow_id: string;
  status: string;
  current_step_index: number;
  total_steps: number;
  pause_reason?: string;
  error_summary?: string;
  created_at: string;
}

export function useRuns(workflowId?: string) {
  const { data, loading, error, fetchData } = useApiData<RunSummary[]>();
  const { request } = useApi();

  useEffect(() => {
    const params = workflowId ? `?workflow_id=${workflowId}` : "";
    fetchData("GET", `/runs${params}`);
  }, [workflowId]);

  const cancelRun = async (runId: string) => {
    await request("POST", `/runs/${runId}/cancel`);
  };

  const deleteAllRuns = async () => {
    await request("DELETE", "/runs");
  };

  return { runs: data || [], loading, error, refetch: () => {
    const params = workflowId ? `?workflow_id=${workflowId}` : "";
    fetchData("GET", `/runs${params}`);
  }, cancelRun, deleteAllRuns };
}
