import { useEffect, useCallback } from "react";
import { useApi, useApiData } from "./useApi";

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  status: string;
  workflow_type: string;
  version: number;
  target_url?: string;
  created_at: string;
}

export function useWorkflows(pollInterval?: number, workflowType?: "system" | "user") {
  const { data, loading, error, fetchData } = useApiData<WorkflowSummary[]>();
  const { request } = useApi();

  const path = workflowType ? `/workflows?type=${workflowType}` : "/workflows";

  const refetch = useCallback(() => {
    fetchData("GET", path);
  }, [fetchData, path]);

  const deleteWorkflow = useCallback(async (workflowId: string) => {
    await request("DELETE", `/workflows/${workflowId}`);
  }, [request]);

  const deleteAllWorkflows = useCallback(async () => {
    const target = workflowType ? `/workflows?type=${workflowType}` : "/workflows";
    await request("DELETE", target);
  }, [request, workflowType]);

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
