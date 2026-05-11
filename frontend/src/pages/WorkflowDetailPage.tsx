import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import { useApiData } from "../hooks/useApi";
import { Play, ArrowLeft, List, FileText } from "lucide-react";

interface Step {
  step_index: number;
  action_type: string;
  intent?: string;
}

interface WorkflowDetail {
  id: string;
  name: string;
  description?: string;
  prompt?: string;
  target_url?: string;
  status: string;
  version: number;
  steps: Step[];
}

export default function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const { data, loading, error, fetchData } = useApiData<WorkflowDetail>();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (workflowId) fetchData("GET", `/workflows/${workflowId}`);
  }, [workflowId]);

  const handleRun = async () => {
    if (!workflowId) return;
    setRunning(true);
    try {
      await fetchData("POST", `/workflows/${workflowId}/run`);
    } catch {
      // handled by fetchData
    }
    setRunning(false);
  };

  if (loading) {
    return <div className="text-[#9AA0B0] text-sm">Loading...</div>;
  }

  if (error || !data) {
    return (
      <div>
        <div className="text-[#E17055] text-sm">Error: {error || "Workflow not found"}</div>
        <button onClick={() => navigate("/workflows")} className="mt-4 text-[#6C5CE7] text-sm">← Back to Workflows</button>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => navigate("/workflows")}
        className="flex items-center gap-1 text-[#9AA0B0] text-sm mb-4 hover:text-[#E8EAED] transition-colors"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-[#E8EAED] mb-1">{data.name}</h1>
          {data.description && (
            <p className="text-[#9AA0B0] text-sm mb-2">{data.description}</p>
          )}
          <div className="flex items-center gap-4 text-xs text-[#9AA0B0]">
            <StatusBadge status={data.status as any} size="sm" />
            <span>Version {data.version}</span>
            {data.target_url && <span>{data.target_url}</span>}
          </div>
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors disabled:opacity-50"
        >
          <Play size={14} /> {running ? "Starting..." : "Run"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-3 flex items-center gap-2">
            <List size={14} /> Steps ({data.steps.length})
          </h2>
          <div className="space-y-1">
            {data.steps.map((step) => (
              <div
                key={step.step_index}
                className="flex items-center gap-3 py-2 px-3 rounded-md text-sm text-[#E8EAED] hover:bg-[#242836] transition-colors"
              >
                <span className="text-[#6B7280] text-xs w-5">{step.step_index}.</span>
                <span className="text-[#74B9FF] text-xs uppercase">{step.action_type}</span>
                {step.intent && <span className="text-[#9AA0B0]">{step.intent}</span>}
              </div>
            ))}
          </div>
        </Card>

        {data.prompt && (
          <Card>
            <h2 className="text-sm font-medium text-[#E8EAED] mb-3 flex items-center gap-2">
              <FileText size={14} /> Intent / Prompt
            </h2>
            <p className="text-[#9AA0B0] text-sm italic">"{data.prompt}"</p>
          </Card>
        )}
      </div>
    </div>
  );
}
