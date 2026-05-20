import { useEffect, useCallback } from "react";
import { useApi, useApiData } from "./useApi";

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
  const { request } = useApi();

  const refetch = useCallback(() => {
    fetchData("GET", "/workflows");
  }, [fetchData]);

  const deleteWorkflow = useCallback(async (workflowId: string) => {
    await request("DELETE", `/workflows/${workflowId}`);
  }, [request]);

  const deleteAllWorkflows = useCallback(async () => {
    await request("DELETE", "/workflows");
  }, [request]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    if (!pollInterval) return;
    const id = setInterval(refetch, pollInterval);
    return () => clearInterval(id);
  }, [pollInterval, refetch]);

  return { workflows: data || [], loading, error, refetch, deleteWorkflow, deleteAllWorkflows };
}
