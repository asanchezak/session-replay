import { useEffect, useCallback } from "react";
import { useApiData } from "./useApi";

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  status: string;
  version: number;
  target_url?: string;
  created_at: string;
}

export function useWorkflows(pollInterval?: number) {
  const { data, loading, error, fetchData } = useApiData<WorkflowSummary[]>();

  const refetch = useCallback(() => {
    fetchData("GET", "/workflows");
  }, [fetchData]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!pollInterval) return;
    const id = setInterval(refetch, pollInterval);
    return () => clearInterval(id);
  }, [pollInterval, refetch]);

  return { workflows: data || [], loading, error, refetch };
}
