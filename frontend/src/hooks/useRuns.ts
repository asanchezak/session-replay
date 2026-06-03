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
