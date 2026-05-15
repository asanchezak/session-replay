import { useEffect, useState } from "react";

interface Intervention {
  id: string;
  run_id: string;
  trigger_reason: string;
  paused_at: string;
  priority: number;
}

export default function HumanInterventionPage() {
  const [interventions, setInterventions] = useState<Intervention[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch("/v1/interventions");
        if (resp.ok) {
          const data = await resp.json();
          setInterventions(data.interventions || []);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <div>Loading...</div>;

  if (interventions.length === 0) {
    return (
      <div className="p-8 text-center text-secondary">
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
          <div key={inv.id} className="p-4 bg-surface rounded-md border border-border">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{inv.trigger_reason}</span>
              <span className={`text-xs px-2 py-1 rounded ${inv.priority >= 3 ? "bg-error text-white" : "bg-warning text-black"}`}>
                P{inv.priority}
              </span>
            </div>
            <p className="text-xs text-muted mt-1">Run: {inv.run_id}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
