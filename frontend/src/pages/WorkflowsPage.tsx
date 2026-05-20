import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useWorkflows, type WorkflowSummary } from "../hooks/useWorkflows";
import { logger } from "../lib/logger";
import { formatTime } from "../lib/formatTime";
import { GitBranch, Plus, Trash2 } from "lucide-react";

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { workflows, loading, error, refetch, deleteAllWorkflows } = useWorkflows();
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAll = async () => {
    if (!window.confirm(`Delete all ${workflows.length} workflow(s)? This cannot be undone.`)) {
      return;
    }
    setDeleting(true);
    try {
      await deleteAllWorkflows();
    } catch (err) {
      logger.error(
        "WorkflowsPage",
        "delete_all",
        {},
        err instanceof Error ? err : undefined,
      );
    }
    setDeleting(false);
    refetch();
    window.dispatchEvent(new CustomEvent("workflows:updated"));
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Workflows</h1>
        <div className="text-text-secondary text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-text-primary">Workflows</h1>
        <Card>
          <div className="text-error text-sm">Error loading workflows: {error}</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Workflows</h1>
        <div className="flex items-center gap-2">
          {workflows.length > 0 && (
            <button
              onClick={handleDeleteAll}
              disabled={deleting}
              className="flex items-center gap-2 px-3 py-2 border border-error text-error text-sm rounded-md hover:bg-error/10 transition-colors disabled:opacity-50"
            >
              <Trash2 size={14} /> {deleting ? "Deleting…" : `Delete all (${workflows.length})`}
            </button>
          )}
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-2 px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
          >
            <Plus size={14} /> New
          </button>
        </div>
      </div>

      <Card padding="sm">
        <DataTable
          columns={[
            { key: "name", label: "Name", render: (w: WorkflowSummary) => (
              <span className="font-medium">{w.name}</span>
            )},
            { key: "connector", label: "Connector", render: () => "—" },
            { key: "status", label: "Status", render: (w: WorkflowSummary) => (
              <StatusBadge status={w.status as any} size="sm" />
            )},
            { key: "version", label: "Version", render: (w: WorkflowSummary) => (
              <span className="text-text-secondary">v{w.version}</span>
            )},
            { key: "created", label: "Created", render: (w: WorkflowSummary) => (
              <span className="text-text-secondary">{formatTime(w.created_at)}</span>
            )},
          ]}
          data={workflows}
          keyExtractor={(w) => w.id}
          onRowClick={(w) => navigate(`/workflows/${w.id}`)}
          emptyState={
            <EmptyState
              icon={<GitBranch size={32} />}
              title="No workflows yet"
              description="Record your first workflow from the browser extension, or start from a template."
              actions={
                <>
                  <button
                    onClick={() => navigate("/settings")}
                    className="px-3 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors"
                  >
                    Install Extension
                  </button>
                  <button
                    onClick={() => navigate("/dashboard")}
                    className="px-3 py-2 bg-bg-elevated text-text-primary text-sm rounded-md hover:bg-bg-input transition-colors"
                  >
                    Open Dashboard
                  </button>
                </>
              }
            />
          }
        />
      </Card>
    </div>
  );
}
