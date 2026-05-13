import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useRuns, type RunSummary } from "../hooks/useRuns";
import { formatTime } from "../lib/formatTime";
import { Play } from "lucide-react";

export default function RunsPage() {
  const { runs, loading, error } = useRuns();

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Runs</h1>
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Runs</h1>
        <Card>
          <div className="text-error text-sm">Error loading runs: {error}</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4 text-text-primary">Runs</h1>
      <Card padding="sm">
        <DataTable
          columns={[
            { key: "id", label: "Run", render: (r: RunSummary) => (
              <span className="text-accent font-mono text-xs">#{r.id.slice(0, 8)}</span>
            )},
            { key: "status", label: "Status", render: (r: RunSummary) => (
              <StatusBadge status={r.status as any} size="sm" />
            )},
            { key: "step", label: "Step", render: (r: RunSummary) => (
              <span className="text-text-secondary">{r.current_step_index}/{r.total_steps}</span>
            )},
            { key: "error", label: "Error", render: (r: RunSummary) => (
              <span className="text-error text-xs">{r.error_summary || "—"}</span>
            )},
            { key: "created", label: "Started", render: (r: RunSummary) => (
              <span className="text-text-secondary text-xs">{formatTime(r.created_at)}</span>
            )},
          ]}
          data={runs}
          keyExtractor={(r) => r.id}
          emptyState={
            <EmptyState
              icon={<Play size={32} />}
              title="No runs yet"
              description="Start a workflow to see execution history here."
              actions={
                <button className="px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors">
                  Browse Workflows
                </button>
              }
            />
          }
        />
      </Card>
    </div>
  );
}
