import { useEffect } from "react";
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

export function useWorkflows() {
  const { data, loading, error, fetchData } = useApiData<WorkflowSummary[]>();

  useEffect(() => {
    fetchData("GET", "/workflows");
  }, []);

  return { workflows: data || [], loading, error, refetch: () => fetchData("GET", "/workflows") };
}
