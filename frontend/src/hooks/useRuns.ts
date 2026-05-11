import { useEffect } from "react";
import { useApiData } from "./useApi";

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

  useEffect(() => {
    const params = workflowId ? `?workflow_id=${workflowId}` : "";
    fetchData("GET", `/runs${params}`);
  }, [workflowId]);

  return { runs: data || [], loading, error, refetch: () => {
    const params = workflowId ? `?workflow_id=${workflowId}` : "";
    fetchData("GET", `/runs${params}`);
  }};
}
