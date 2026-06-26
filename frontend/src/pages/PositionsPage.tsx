import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useRuns, runPosition, runJobId, type RunSummary } from "../hooks/useRuns";
import { formatTime } from "../lib/formatTime";
import { Briefcase } from "lucide-react";

interface PositionGroup {
  jobId: string;
  position: string;
  runCount: number;
  latest: RunSummary;
}

/** Group runs by their Odoo job id so each active position reads as one row. */
function groupByPosition(runs: RunSummary[]): PositionGroup[] {
  const byJob = new Map<string, PositionGroup>();
  for (const run of runs) {
    const jobId = runJobId(run.origin);
    if (!jobId) continue;
    const existing = byJob.get(jobId);
    if (!existing) {
      byJob.set(jobId, {
        jobId,
        position: runPosition(run.origin) || `Job ${jobId}`,
        runCount: 1,
        latest: run,
      });
    } else {
      existing.runCount += 1;
      if (!existing.position && runPosition(run.origin)) existing.position = runPosition(run.origin);
      if (new Date(run.created_at).getTime() > new Date(existing.latest.created_at).getTime()) {
        existing.latest = run;
      }
    }
  }
  return [...byJob.values()].sort(
    (a, b) => new Date(b.latest.created_at).getTime() - new Date(a.latest.created_at).getTime()
  );
}

export default function PositionsPage() {
  const { runs, loading, error } = useRuns();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Positions</h1>
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Positions</h1>
        <Card>
          <div className="text-error text-sm">Error loading positions: {error}</div>
        </Card>
      </div>
    );
  }

  const positions = groupByPosition(runs);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Positions</h1>
        <span className="text-text-secondary text-xs">{positions.length} active</span>
      </div>
      <Card padding="sm">
        <DataTable
          columns={[
            { key: "position", label: "Position", render: (p: PositionGroup) => (
              <span className="text-text-primary text-sm font-medium">
                {p.position}
                <span className="ml-2 px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-mono align-middle">
                  job {p.jobId}
                </span>
              </span>
            )},
            { key: "runs", label: "Runs", render: (p: PositionGroup) => (
              <span className="text-text-secondary text-xs">{p.runCount}</span>
            )},
            { key: "status", label: "Latest", render: (p: PositionGroup) => (
              <StatusBadge status={p.latest.status as any} size="sm" />
            )},
            { key: "updated", label: "Last activity", render: (p: PositionGroup) => (
              <span className="text-text-secondary text-xs">{formatTime(p.latest.created_at)}</span>
            )},
          ]}
          data={positions}
          keyExtractor={(p) => p.jobId}
          onRowClick={(p) => navigate(`/positions/${p.jobId}`)}
          emptyState={
            <EmptyState
              icon={<Briefcase size={32} />}
              title="No positions yet"
              description="Positions appear here once their LinkedIn automations have run."
              actions={
                <button
                  onClick={() => navigate("/runs")}
                  className="px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
                >
                  View Runs
                </button>
              }
            />
          }
        />
      </Card>
    </div>
  );
}
