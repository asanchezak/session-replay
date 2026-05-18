import { useEffect } from "react";
import Card from "../components/Card";
import Banner from "../components/Banner";
import { useApiData } from "../hooks/useApi";

interface Intervention {
  id: string;
  run_id: string;
  trigger_reason: string;
  paused_at: string;
  priority?: number;
}

export default function HumanInterventionPage() {
  const { data, loading, error, fetchData } = useApiData<{ interventions: Intervention[] }>();

  useEffect(() => {
    fetchData("GET", "/interventions");
  }, [fetchData]);

  const interventions = data?.interventions || [];

  if (loading) return <div>Loading...</div>;

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Action Center</h1>
        <Card>
          <Banner type="error" title="Failed to load interventions">
            {error}
          </Banner>
        </Card>
      </div>
    );
  }

  if (interventions.length === 0) {
    return (
      <div className="p-8 text-center text-text-secondary">
        <p className="text-lg">No pending interventions</p>
        <p className="text-sm mt-2">All clear — no workflows need your attention.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold mb-4">Action Center</h1>
      <div className="space-y-2">
        {interventions.map((inv) => (
          <div key={inv.id} className="p-4 bg-bg-surface rounded-md border border-border">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{inv.trigger_reason}</span>
              <span className={`text-xs px-2 py-1 rounded ${(inv.priority || 1) >= 3 ? "bg-error text-white" : "bg-warning text-black"}`}>
                P{inv.priority || 1}
              </span>
            </div>
            <p className="text-xs text-text-muted mt-1">Run: {inv.run_id}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
