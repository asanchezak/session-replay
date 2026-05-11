import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useRuns, type RunSummary } from "../hooks/useRuns";
import { Play } from "lucide-react";

export default function RunsPage() {
  const { runs, loading, error } = useRuns();

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-[#E8EAED]">Runs</h1>
        <div className="text-[#9AA0B0] text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-[#E8EAED]">Runs</h1>
        <Card>
          <div className="text-[#E17055] text-sm">Error loading runs: {error}</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4 text-[#E8EAED]">Runs</h1>
      <Card padding="sm">
        <DataTable
          columns={[
            { key: "id", label: "Run", render: (r: RunSummary) => (
              <span className="text-[#6C5CE7] font-mono text-xs">#{r.id.slice(0, 8)}</span>
            )},
            { key: "status", label: "Status", render: (r: RunSummary) => (
              <StatusBadge status={r.status as any} size="sm" />
            )},
            { key: "step", label: "Step", render: (r: RunSummary) => (
              <span className="text-[#9AA0B0]">{r.current_step_index}/{r.total_steps}</span>
            )},
            { key: "error", label: "Error", render: (r: RunSummary) => (
              <span className="text-[#E17055] text-xs">{r.error_summary || "—"}</span>
            )},
            { key: "created", label: "Started", render: (r: RunSummary) => (
              <span className="text-[#9AA0B0] text-xs">{new Date(r.created_at).toLocaleString()}</span>
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
                <button className="px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors">
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
