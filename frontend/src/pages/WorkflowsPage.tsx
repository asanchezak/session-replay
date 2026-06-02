import { useState } from "react";
import type React from "react";
import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import ExecutionModeBadge from "../components/ExecutionModeBadge";
import { useWorkflows, type WorkflowSummary } from "../hooks/useWorkflows";
import { logger } from "../lib/logger";
import { formatTime } from "../lib/formatTime";
import { GitBranch, Plus, Trash2, Settings2, User } from "lucide-react";

type TabType = "system" | "user";

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabType>("system");
  const { workflows, loading, error, refetch, deleteWorkflow, deleteAllWorkflows } = useWorkflows(undefined, activeTab);
  const [deleting, setDeleting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDeleteOne = async (e: React.MouseEvent, workflowId: string) => {
    e.stopPropagation();
    if (!window.confirm("Delete this workflow? This cannot be undone.")) return;
    setDeletingId(workflowId);
    try {
      await deleteWorkflow(workflowId);
      refetch();
    } finally {
      setDeletingId(null);
    }
  };

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

  const emptyMessages = {
    system: { title: "No system workflows", description: "Promote a workflow from My Workflows to make it a system automation." },
    user: { title: "No recorded workflows yet", description: "Record your first workflow from the browser extension." },
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Workflows</h1>
        <div className="flex items-center gap-2">
          {workflows.length > 0 && activeTab === "user" && (
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

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border">
        <button
          onClick={() => setActiveTab("system")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "system"
              ? "border-accent text-text-primary"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <Settings2 size={14} /> System
        </button>
        <button
          onClick={() => setActiveTab("user")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
            activeTab === "user"
              ? "border-accent text-text-primary"
              : "border-transparent text-text-secondary hover:text-text-primary"
          }`}
        >
          <User size={14} /> My Workflows
        </button>
      </div>

      <Card padding="sm">
        <DataTable
          columns={[
            { key: "name", label: "Name", render: (w: WorkflowSummary) => (
              <span className="font-medium">{w.name}</span>
            )},
            { key: "mode", label: "Mode", render: (w: WorkflowSummary) => (
              <ExecutionModeBadge mode={w.execution_mode} />
            )},
            { key: "connector", label: "Connector", render: () => "—" },
            { key: "version", label: "Version", render: (w: WorkflowSummary) => (
              <span className="text-text-secondary">v{w.version}</span>
            )},
            { key: "created", label: "Created", render: (w: WorkflowSummary) => (
              <span className="text-text-secondary">{formatTime(w.created_at)}</span>
            )},
            ...(activeTab === "user" ? [{
              key: "delete",
              label: "",
              render: (w: WorkflowSummary) => (
                <button
                  onClick={(e) => handleDeleteOne(e, w.id)}
                  disabled={deletingId === w.id}
                  className="p-1 text-text-gray hover:text-error transition-colors disabled:opacity-50"
                  title="Delete workflow"
                >
                  <Trash2 size={14} />
                </button>
              ),
            }] : []),
          ]}
          data={workflows}
          keyExtractor={(w) => w.id}
          onRowClick={(w) => navigate(`/workflows/${w.id}`)}
          emptyState={
            <EmptyState
              icon={activeTab === "system" ? <Settings2 size={32} /> : <GitBranch size={32} />}
              title={emptyMessages[activeTab].title}
              description={emptyMessages[activeTab].description}
              actions={
                activeTab === "user" ? (
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
                ) : (
                  <button
                    onClick={() => setActiveTab("user")}
                    className="px-3 py-2 bg-bg-elevated text-text-primary text-sm rounded-md hover:bg-bg-input transition-colors"
                  >
                    View My Workflows
                  </button>
                )
              }
            />
          }
        />
      </Card>
    </div>
  );
}
