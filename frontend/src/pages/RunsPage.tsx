import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useRuns, pipelineLabel, pipelineJobId, type RunSummary } from "../hooks/useRuns";
import { useWorkflows } from "../hooks/useWorkflows";
import { logger } from "../lib/logger";
import { formatTime } from "../lib/formatTime";
import { Play, Square, Trash2 } from "lucide-react";

const CANCELABLE_STATUSES = ["running", "queued", "waiting_for_user", "recovering"];

export default function RunsPage() {
  const { runs, loading, error, refetch, cancelRun, deleteAllRuns } = useRuns();
  const { workflows } = useWorkflows();
  const workflowName = new Map(workflows.map((w) => [w.id, w.name]));
  const navigate = useNavigate();
  const [canceling, setCanceling] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const cancelableRuns = runs.filter((r) => CANCELABLE_STATUSES.includes(r.status));
  const hasCancelable = cancelableRuns.length > 0;

  const handleDeleteAll = async () => {
    if (!window.confirm(`Delete all ${runs.length} run(s)? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await deleteAllRuns();
    } catch (err) {
      logger.error("RunsPage", "delete_all", {}, err instanceof Error ? err : undefined);
    }
    setDeleting(false);
    refetch();
    window.dispatchEvent(new CustomEvent("runs:updated"));
  };

  const handleCancelAll = async () => {
    setCanceling(new Set(cancelableRuns.map((r) => r.id)));
    for (const r of cancelableRuns) {
      try {
        await cancelRun(r.id);
      } catch (err) {
        logger.error("RunsPage", "cancel_all", { run_id: r.id }, err instanceof Error ? err : undefined);
      }
    }
    setCanceling(new Set());
    refetch();
    window.dispatchEvent(new CustomEvent("runs:updated"));
  };

  const handleCancel = async (runId: string) => {
    setCanceling((prev) => new Set(prev).add(runId));
    try {
      await cancelRun(runId);
    } catch (err) {
      logger.error("RunsPage", "cancel_run", { run_id: runId }, err instanceof Error ? err : undefined);
    }
    setCanceling((prev) => {
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
    refetch();
    window.dispatchEvent(new CustomEvent("runs:updated"));
  };

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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Runs</h1>
        <div className="flex items-center gap-2">
          {hasCancelable && (
            <button
              onClick={handleCancelAll}
              className="flex items-center gap-2 px-3 py-2 border border-error text-error text-sm rounded-md hover:bg-error/10 transition-colors"
            >
              <Square size={14} /> Cancel all ({cancelableRuns.length})
            </button>
          )}
          {runs.length > 0 && (
            <button
              onClick={handleDeleteAll}
              disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 border border-error text-error text-sm rounded-md hover:bg-error/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} /> {deleting ? "Deleting…" : `Delete all (${runs.length})`}
            </button>
          )}
        </div>
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
              // Concise: drop the "Recruiter:" prefix every recruiter workflow carries, and
              // truncate the (often long) descriptive name — full name on hover.
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
            { key: "pipeline", label: "Position", render: (r: RunSummary) => {
              const label = pipelineLabel(r.origin);
              const jobId = pipelineJobId(r.origin);
              if (!label) return <span className="text-text-tertiary text-xs">—</span>;
              return (
                <span className="text-text-secondary text-xs whitespace-nowrap">
                  {label}
                  {jobId && (
                    <span className="ml-2 px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-mono">
                      job {jobId}
                    </span>
                  )}
                </span>
              );
            }},
            { key: "status", label: "Status", render: (r: RunSummary) => (
              <StatusBadge status={r.status as any} size="sm" />
            )},
            { key: "error", label: "Error", render: (r: RunSummary) => (
              <span className="text-error text-xs">{r.error_summary || "—"}</span>
            )},
            { key: "created", label: "Started", render: (r: RunSummary) => (
              <span className="text-text-secondary text-xs">{formatTime(r.created_at)}</span>
            )},
            { key: "actions", label: "", render: (r: RunSummary) => (
              CANCELABLE_STATUSES.includes(r.status) ? (
                <button
                  onClick={() => handleCancel(r.id)}
                  disabled={canceling.has(r.id)}
                  className="px-2 py-1 text-xs text-error border border-error rounded-md hover:bg-error/10 transition-colors disabled:opacity-50"
                >
                  {canceling.has(r.id) ? "Canceling…" : "Cancel"}
                </button>
              ) : null
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
                <button
                  onClick={() => navigate("/workflows")}
                  className="px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
                >
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
