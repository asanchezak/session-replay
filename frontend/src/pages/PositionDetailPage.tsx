import { useNavigate, useParams } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import {
  useRuns,
  pipelineLabel,
  runPosition,
  runJobId,
  type RunSummary,
} from "../hooks/useRuns";
import { useWorkflows } from "../hooks/useWorkflows";
import { formatTime } from "../lib/formatTime";
import { Play } from "lucide-react";

export default function PositionDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { runs, loading, error } = useRuns();
  const { workflows } = useWorkflows();
  const workflowName = new Map(workflows.map((w) => [w.id, w.name]));
  const navigate = useNavigate();

  const positionRuns = runs.filter((r) => runJobId(r.origin) === jobId);
  const positionName =
    positionRuns.map((r) => runPosition(r.origin)).find(Boolean) || `Job ${jobId}`;

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Position</h1>
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Position</h1>
        <Card>
          <div className="text-error text-sm">Error loading runs: {error}</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-semibold text-text-primary">{positionName}</h1>
        <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-mono">
          job {jobId}
        </span>
        <span className="text-text-secondary text-xs">
          {positionRuns.length} run{positionRuns.length === 1 ? "" : "s"}
        </span>
      </div>
      <Card padding="sm">
        <DataTable
          columns={[
            { key: "id", label: "Run", render: (r: RunSummary) => (
              <span
                className="text-accent font-mono text-xs cursor-pointer hover:text-accent-hover"
                onClick={() => navigate(`/runs/${r.id}`)}
              >
                #{r.id.slice(0, 8)}
              </span>
            )},
            { key: "workflow", label: "Workflow", render: (r: RunSummary) => {
              const full = workflowName.get(r.workflow_id) || `#${r.workflow_id.slice(0, 8)}`;
              const concise = full.replace(/^recruiter:\s*/i, "");
              return (
                <span
                  className="text-text-secondary text-xs truncate inline-block max-w-[220px] align-middle"
                  title={full}
                >
                  {concise}
                </span>
              );
            }},
            { key: "stage", label: "Stage", render: (r: RunSummary) => {
              const label = pipelineLabel(r.origin);
              return label ? (
                <span className="text-text-secondary text-xs whitespace-nowrap">{label}</span>
              ) : (
                <span className="text-text-tertiary text-xs">—</span>
              );
            }},
            { key: "status", label: "Status", render: (r: RunSummary) => (
              <StatusBadge status={r.status as any} size="sm" />
            )},
            { key: "created", label: "Started", render: (r: RunSummary) => (
              <span className="text-text-secondary text-xs">{formatTime(r.created_at)}</span>
            )},
          ]}
          data={positionRuns}
          keyExtractor={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          emptyState={
            <EmptyState
              icon={<Play size={32} />}
              title="No runs for this position"
              description="This position has no related runs."
              actions={
                <button
                  onClick={() => navigate("/positions")}
                  className="px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
                >
                  Back to Positions
                </button>
              }
            />
          }
        />
      </Card>
    </div>
  );
}
