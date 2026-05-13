import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import Banner from "../components/Banner";
import DataTable from "../components/DataTable";
import { useRuns, type RunSummary } from "../hooks/useRuns";
import { useWorkflows, type WorkflowSummary } from "../hooks/useWorkflows";
import { GitBranch, Play, AlertTriangle, Activity, Cable } from "lucide-react";

export default function DashboardPage() {
  const navigate = useNavigate();
  const { workflows, loading: wfLoading } = useWorkflows();
  const { runs, loading: runLoading } = useRuns();

  const activeWorkflows = workflows.filter((w) => w.status === "active").length;
  const failedRuns = runs.filter((r) => r.status === "failed");
  const waitingRuns = runs.filter((r) => r.status === "waiting_for_user").length;
  const completedRuns = runs.filter((r) => r.status === "completed").length;
  const totalRuns = runs.length;
  const successRate = totalRuns > 0 ? Math.round((completedRuns / totalRuns) * 10000) / 100 : 0;

  const recentRuns = [...runs].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  ).slice(0, 5);

  const displayedFailed = failedRuns.slice(0, 10);
  const hiddenFailed = failedRuns.length - 10;

  const needsAttention = [
    ...runs.filter((r) => r.status === "waiting_for_user").map((r) => `Run #${r.id.slice(0, 6)} — ${r.pause_reason || "Paused"}`),
    ...displayedFailed.map((r) => `Run #${r.id.slice(0, 6)} — ${r.error_summary || "Failed"}`),
  ];

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6 text-text-primary">Dashboard</h1>

      <div className="grid grid-cols-5 gap-4 mb-6">
        <Card>
          <div className="text-text-secondary text-xs mb-1 flex items-center gap-2">
            <GitBranch size={12} /> Active Workflows
          </div>
          <div className="text-2xl font-semibold text-text-primary">
            {wfLoading ? "..." : activeWorkflows}
          </div>
        </Card>
        <Card>
          <div className="text-text-secondary text-xs mb-1 flex items-center gap-2">
            <Activity size={12} /> Success Rate
          </div>
          <div className="text-2xl font-semibold text-success">
            {runLoading ? "..." : `${successRate}%`}
          </div>
        </Card>
        <Card>
          <div className="text-text-secondary text-xs mb-1 flex items-center gap-2">
            <AlertTriangle size={12} /> Waiting for You
          </div>
          <div className="text-2xl font-semibold text-warning">
            {runLoading ? "..." : waitingRuns}
          </div>
        </Card>
        <Card>
          <div className="text-text-secondary text-xs mb-1 flex items-center gap-2">
            <Play size={12} /> Failed Runs
          </div>
          <div className="text-2xl font-semibold text-error">
            {runLoading ? "..." : failedRuns.length}
          </div>
        </Card>
        <Card>
          <div className="text-text-secondary text-xs mb-1 flex items-center gap-2">
            <Cable size={12} /> Connectors
          </div>
          <div className="text-2xl font-semibold text-text-primary">Odoo</div>
        </Card>
      </div>

      {needsAttention.length > 0 && (
        <div className="mb-6">
          <Banner type="warning" title="Requires Attention">
            <ul className="list-disc pl-4 space-y-1">
              {needsAttention.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            {hiddenFailed > 0 && (
              <button
                onClick={() => navigate("/runs?status=failed")}
                className="text-accent hover:text-accent-hover text-sm mt-2 underline"
              >
                View all {hiddenFailed} more failed runs...
              </button>
            )}
          </Banner>
        </div>
      )}

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <h2 className="text-sm font-medium text-text-primary mb-3">Recent Runs</h2>
          {runLoading ? (
            <div className="text-text-secondary text-sm">Loading...</div>
          ) : (
            <div className="space-y-2">
              {recentRuns.map((run) => (
                <div
                  key={run.id}
                  onClick={() => navigate(`/workflows/${run.workflow_id}`)}
                  className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-bg-elevated cursor-pointer transition-colors"
                >
                  <span className="text-sm text-text-primary">
                    Run #{run.id.slice(0, 6)}
                  </span>
                  <StatusBadge status={run.status as any} size="sm" />
                </div>
              ))}
              {recentRuns.length === 0 && (
                <div className="text-text-secondary text-sm">No runs yet.</div>
              )}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-medium text-text-primary mb-3">Workflow Templates</h2>
          <div className="space-y-2">
            {["Search & Extract", "Fill & Submit", "Open & Inspect"].map((tpl) => (
              <div
                key={tpl}
                className="py-2 px-3 rounded-md hover:bg-bg-elevated cursor-pointer transition-colors text-sm text-text-secondary hover:text-text-primary"
              >
                {tpl}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
