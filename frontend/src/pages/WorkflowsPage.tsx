import { useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import DataTable from "../components/DataTable";
import EmptyState from "../components/EmptyState";
import { useWorkflows, type WorkflowSummary } from "../hooks/useWorkflows";
import { GitBranch, Plus, Search } from "lucide-react";

export default function WorkflowsPage() {
  const navigate = useNavigate();
  const { workflows, loading, error } = useWorkflows();

  if (loading) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-[#E8EAED]">Workflows</h1>
        <div className="text-[#9AA0B0] text-sm">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <h1 className="text-xl font-semibold mb-4 text-[#E8EAED]">Workflows</h1>
        <Card>
          <div className="text-[#E17055] text-sm">Error loading workflows: {error}</div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-[#E8EAED]">Workflows</h1>
        <button className="flex items-center gap-2 px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors">
          <Plus size={14} /> New
        </button>
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
              <span className="text-[#9AA0B0]">v{w.version}</span>
            )},
            { key: "created", label: "Created", render: (w: WorkflowSummary) => (
              <span className="text-[#9AA0B0]">{new Date(w.created_at).toLocaleDateString()}</span>
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
                  <button className="px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors">
                    Install Extension
                  </button>
                  <button className="px-3 py-2 bg-[#242836] text-[#E8EAED] text-sm rounded-md hover:bg-[#2A2E3D] transition-colors">
                    Use Template
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
