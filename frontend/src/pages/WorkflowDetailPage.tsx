import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import { ParameterForm } from "../components/ParameterForm";
import { PhaseTimeline } from "../components/PhaseTimeline";
import { ConfidenceIndicator } from "../components/ConfidenceIndicator";
import { OutputSchemaPreview } from "../components/OutputSchemaPreview";
import { RunParameterModal } from "../components/RunParameterModal";
import Banner from "../components/Banner";
import { useApi, useApiData } from "../hooks/useApi";
import { Play, ArrowLeft, List, FileText, Brain, Settings2, BarChart3, Pencil } from "lucide-react";

interface Step {
  step_index: number;
  action_type: string;
  intent?: string;
  selector_chain?: Array<{ type: string; value: string }>;
  value?: string;
}

interface AnalysisPhase {
  phase_index: number;
  phase_name: string;
  phase_goal: string | null;
  start_step_index: number;
  end_step_index: number;
}

interface AnalysisParam {
  key: string;
  type: "string" | "number" | "boolean" | "list";
  default: string | null;
  description: string | null;
  confidence: number;
  required: boolean;
}

interface AnalysisOutputSpec {
  type: string;
  schema: Record<string, unknown> | null;
  confidence: number;
}

interface Analysis {
  workflow_goal: string | null;
  workflow_summary: string | null;
  confidence_overall: number;
  replay_strategy: string | null;
  is_user_edited: boolean;
  ambiguity_notes?: Record<string, unknown> | null;
  phases: AnalysisPhase[];
  parameters: AnalysisParam[];
  output_spec: AnalysisOutputSpec;
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
  analysis: Analysis | null;
}

export default function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const { request } = useApi();
  const { data, loading, error, fetchData } = useApiData<WorkflowDetail>();
  const [running, setRunning] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [viewMode, setViewMode] = useState<"literal" | "semantic">("semantic");
  const [runError, setRunError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (workflowId) fetchData("GET", `/workflows/${workflowId}`);
  }, [workflowId]);

  const waitForRunStarted = (): Promise<
    | { type: "started"; runId: string }
    | { type: "failed"; error: string }
    | { type: "timeout" }
  > => {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve({ type: "timeout" });
      }, 10000);
      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.type === "DASHBOARD_RUN_STARTED" && event.data.runId) {
          clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve({ type: "started", runId: event.data.runId as string });
          return;
        }
        if (event.data?.type === "DASHBOARD_RUN_FAILED") {
          clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve({
            type: "failed",
            error: typeof event.data.error === "string"
              ? event.data.error
              : "Failed to start run",
          });
        }
      };
      window.addEventListener("message", handler);
    });
  };

  const startWorkflowRun = async (
    params: Record<string, string> = {},
    goal?: string,
    failureMessage = "Failed to start run",
  ) => {
    if (!workflowId) return;
    setRunError(null);
    setRunning(true);
    setShowGoalModal(false);
    setShowParamModal(false);
    // Open a placeholder run window immediately. Once the extension reports
    // the run id, we point the same window at /runs/<id>. This is what keeps
    // the run page open for the whole duration of the workflow.
    const runWindow = window.open("/runs/pending", "session-replay-run", "noopener");
    try {
      const message: {
        type: "DASHBOARD_RUN_WORKFLOW";
        workflowId: string;
        params?: Record<string, string>;
        goal?: string;
      } = { type: "DASHBOARD_RUN_WORKFLOW", workflowId };
      if (Object.keys(params).length > 0) {
        message.params = params;
      }
      if (goal) {
        message.goal = goal;
      }
      window.postMessage(
        message,
        "*",
      );
      const outcome = await waitForRunStarted();
      if (outcome.type === "started") {
        if (runWindow && !runWindow.closed) {
          runWindow.location.href = `/runs/${outcome.runId}`;
        } else {
          // Popup blocked or user closed it — fall back to navigating in place
          navigate(`/runs/${outcome.runId}`);
        }
      } else if (outcome.type === "failed") {
        if (runWindow && !runWindow.closed) {
          runWindow.close();
        }
        setRunError(outcome.error);
      } else {
        if (runWindow && !runWindow.closed) {
          runWindow.close();
        }
        setRunError("Run did not start. Confirm the extension is installed and connected.");
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : failureMessage);
      if (runWindow && !runWindow.closed) runWindow.close();
    }
    setRunning(false);
  };

  const handleRun = async () => {
    if (!workflowId) return;
    setRunError(null);
    const analysis = data?.analysis;
    if (analysis?.parameters && analysis.parameters.length > 0 && analysis.replay_strategy === "parameterized") {
      setShowParamModal(true);
      return;
    }
    setShowGoalModal(true);
  };

  const handleActivate = async () => {
    if (!workflowId) return;
    setActivating(true);
    try {
      await request("PUT", `/workflows/${workflowId}/status`, { status: "active" });
      fetchData("GET", `/workflows/${workflowId}`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to activate workflow");
    }
    setActivating(false);
  };

  const startEditName = () => {
    setNameInput(data?.name || "");
    setEditingName(true);
  };

  const saveName = async () => {
    if (!workflowId || !nameInput.trim()) return;
    try {
      await request("PUT", `/workflows/${workflowId}`, { name: nameInput.trim() });
      fetchData("GET", `/workflows/${workflowId}`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to update name");
    }
    setEditingName(false);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setNameInput("");
  };

  const handleAnalyze = async () => {
    if (!workflowId) return;
    setAnalyzing(true);
    setRunError(null);
    try {
      await request("POST", `/workflows/${workflowId}/analyze`);
      fetchData("GET", `/workflows/${workflowId}`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to analyze workflow");
    }
    setAnalyzing(false);
  };

  const handleRunWithParams = async (params: Record<string, string>, goal?: string) => {
    await startWorkflowRun(params, goal, "Failed to start parameterized run");
  };

  if (loading) {
    return (
      <div>
        <button onClick={() => navigate("/workflows")} className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="flex items-center gap-3 py-8">
          <div className="w-5 h-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <span className="text-text-secondary text-sm">Loading workflow...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div>
        <button onClick={() => navigate("/workflows")} className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors">
          <ArrowLeft size={14} /> Back
        </button>
        <Banner type="error" title="Failed to load workflow">
          <p className="mb-3">{error || "Workflow not found"}</p>
          <button onClick={() => workflowId && fetchData("GET", `/workflows/${workflowId}`)} className="px-3 py-1 rounded-md bg-accent text-white text-xs hover:bg-accent-hover">
            Retry
          </button>
        </Banner>
      </div>
    );
  }

  const analysis = data.analysis;

  return (
    <div>
      <button
        onClick={() => navigate("/workflows")}
        className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={14} /> Back
      </button>

      {runError && (
        <div className="mb-4">
          <Banner type="error" title="Run failed">
            <p>{runError}</p>
          </Banner>
        </div>
      )}

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") cancelEditName(); }}
                  className="px-2 py-1 rounded-md bg-bg-input border border-border text-text-primary text-xl font-semibold focus:outline-none focus:border-accent"
                  autoFocus
                />
                <button onClick={saveName} className="px-2 py-1 rounded-md bg-accent text-white text-xs hover:bg-accent-hover">Save</button>
                <button onClick={cancelEditName} className="px-2 py-1 rounded-md border border-border text-text-secondary text-xs hover:text-text-primary">Cancel</button>
              </div>
            ) : (
              <h1
                className="text-xl font-semibold text-text-primary cursor-pointer hover:text-accent transition-colors flex items-center gap-2"
                onClick={startEditName}
                title="Click to edit name"
              >
                {data.name}
                <Pencil size={14} className="text-text-muted opacity-50" />
              </h1>
            )}
            {analysis?.confidence_overall !== undefined && (
              <ConfidenceIndicator confidence={analysis.confidence_overall} size="sm" />
            )}
          </div>
          {analysis?.workflow_goal && (
            <p className="text-text-secondary text-sm mb-1">{analysis.workflow_goal}</p>
          )}
          {data.description && !analysis?.workflow_goal && (
            <p className="text-text-secondary text-sm mb-2">{data.description}</p>
          )}
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <StatusBadge status={data.status as any} size="sm" />
            <span>Version {data.version}</span>
            {data.target_url && <span>{data.target_url}</span>}
            {analysis?.replay_strategy && (
              <span className="text-accent">{analysis.replay_strategy} replay</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.status === "draft" && (
            <button
              onClick={handleActivate}
              disabled={activating}
              className="flex items-center gap-2 px-4 py-2 border border-accent text-accent text-sm rounded-md hover:bg-accent/10 transition-colors disabled:opacity-50"
            >
              {activating ? "Activating..." : "Activate"}
            </button>
          )}
          <button
            onClick={handleRun}
            disabled={running || data.status !== "active"}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors disabled:opacity-50"
            title={data.status !== "active" ? "Workflow must be active to run" : ""}
          >
            <Play size={14} /> {running ? "Starting..." : "Run"}
          </button>
        </div>
      </div>

      {/* View mode toggle */}
      {analysis && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setViewMode("semantic")}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${
              viewMode === "semantic"
                ? "bg-accent/20 text-accent border border-accent/30"
                : "text-text-secondary border border-border hover:text-text-primary"
            }`}
          >
            <Brain size={12} className="inline mr-1" />
            Semantic View
          </button>
          <button
            onClick={() => setViewMode("literal")}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${
              viewMode === "literal"
                ? "bg-accent/20 text-accent border border-accent/30"
                : "text-text-secondary border border-border hover:text-text-primary"
            }`}
          >
            <List size={12} className="inline mr-1" />
            Literal View
          </button>
          <div className="flex-1" />
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="text-xs px-3 py-1 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors disabled:opacity-50"
          >
            {analyzing ? "Analyzing..." : "Re-analyze"}
          </button>
        </div>
      )}

      {viewMode === "semantic" && analysis ? (
        <div className="grid grid-cols-2 gap-6">
          {/* Phases */}
          <Card>
            <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
              <BarChart3 size={14} /> Semantic Phases
            </h2>
            <PhaseTimeline phases={analysis.phases || []} />
          </Card>

          {/* Parameters */}
          <Card>
            <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
              <Settings2 size={14} /> Parameters
            </h2>
            <ParameterForm
              parameters={analysis.parameters || []}
              values={{}}
              onChange={() => {}}
            />
          </Card>

          {/* Output Spec */}
          <Card>
            <OutputSchemaPreview
              outputType={analysis.output_spec?.type || "unknown"}
              schema={analysis.output_spec?.schema || null}
              confidence={analysis.output_spec?.confidence || 0}
              onAnalyze={handleAnalyze}
            />
          </Card>

          {/* Summary */}
          {analysis.workflow_summary && (
            <Card>
              <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
                <Brain size={14} /> Analysis Summary
              </h2>
              <p className="text-text-secondary text-sm">{analysis.workflow_summary}</p>
            </Card>
          )}

          {/* Steps anyway in semantic view */}
          <Card className="col-span-2">
            <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
              <List size={14} /> Steps ({data.steps.length})
            </h2>
            <div className="space-y-1">
              {data.steps.map((step) => (
                <div
                  key={step.step_index}
                  className="flex items-center gap-3 py-2 px-3 rounded-md text-sm text-text-primary hover:bg-bg-elevated transition-colors"
                >
                  <span className="text-text-gray text-xs w-5">{step.step_index}.</span>
                  <span className="text-info text-xs uppercase font-medium">{step.action_type}</span>
                  {step.selector_chain && step.selector_chain[0] && (
                    <span className="text-text-gray text-xs font-mono truncate max-w-[200px]" title={step.selector_chain[0].value}>
                      {step.selector_chain[0].value}
                    </span>
                  )}
                  {step.value && <span className="text-text-secondary text-xs">"{step.value.slice(0, 50)}"</span>}
                  {step.intent && <span className="text-text-secondary text-xs italic">{step.intent}</span>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          <Card>
            <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
              <List size={14} /> Steps ({data.steps.length})
            </h2>
            <div className="space-y-1">
              {data.steps.map((step) => (
                <div
                  key={step.step_index}
                  className="flex items-center gap-3 py-2 px-3 rounded-md text-sm text-text-primary hover:bg-bg-elevated transition-colors"
                >
                  <span className="text-text-gray text-xs w-5">{step.step_index}.</span>
                  <span className="text-info text-xs uppercase font-medium">{step.action_type}</span>
                  {step.selector_chain && step.selector_chain[0] && (
                    <span className="text-text-gray text-xs font-mono truncate max-w-[200px]" title={step.selector_chain[0].value}>
                      {step.selector_chain[0].value}
                    </span>
                  )}
                  {step.value && <span className="text-text-secondary text-xs">"{step.value.slice(0, 50)}"</span>}
                  {step.intent && <span className="text-text-secondary text-xs italic">{step.intent}</span>}
                </div>
              ))}
            </div>
          </Card>

          {(data.prompt || analysis) && (
            <Card>
              {data.prompt && (
                <>
                  <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
                    <FileText size={14} /> Intent / Prompt
                  </h2>
                  <p className="text-text-secondary text-sm italic">"{data.prompt}"</p>
                </>
              )}
              {analysis && !data.prompt && (
                <>
                  <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
                    <Brain size={14} /> No analysis yet
                  </h2>
                  <p className="text-text-secondary text-sm">Run analysis to extract semantic understanding.</p>
                </>
              )}
            </Card>
          )}
        </div>
      )}

      {showParamModal && analysis && (
        <RunParameterModal
          parameters={analysis.parameters}
          onRun={handleRunWithParams}
          onCancel={() => setShowParamModal(false)}
          isRunning={running}
          includeGoal
          title="Run with Parameters"
          description="Configure runtime parameters and an optional execution goal before executing this workflow."
          goalLabel="Execution goal (optional)"
          goalPlaceholder='e.g. "Use these parameters, then extract the top 10 matching results"'
        />
      )}
      {showGoalModal && (
        <RunParameterModal
          parameters={[]}
          onRun={(_, goal) => startWorkflowRun({}, goal)}
          onSkip={() => startWorkflowRun()}
          onCancel={() => setShowGoalModal(false)}
          isRunning={running}
          includeGoal
          title="Run With Goal"
          description="Optionally set a goal for this run, or run the workflow exactly as recorded."
          goalLabel="What should this run accomplish?"
          goalPlaceholder='e.g. "Extract the first 10 job descriptions from the current results page"'
          startLabel="Run With Goal"
          skipLabel="Run As Recorded"
        />
      )}
    </div>
  );
}
