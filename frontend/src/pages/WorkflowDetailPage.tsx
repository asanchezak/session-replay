import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import ExecutionModeBadge from "../components/ExecutionModeBadge";
import { PhaseTimeline } from "../components/PhaseTimeline";
import { ConfidenceIndicator } from "../components/ConfidenceIndicator";
import { OutputSchemaPreview } from "../components/OutputSchemaPreview";
import { RunParameterModal } from "../components/RunParameterModal";
import Banner from "../components/Banner";
import { useApi, useApiData } from "../hooks/useApi";
import {
  formatStepLabel,
  getBindingDraftForParameter,
  normalizeWebhookTriggerResponse,
  parameterConsumerSteps,
} from "./viewmodels/workflowDetailViewModel";
import type { ConnectorBindingDraft, WebhookTrigger } from "./viewmodels/workflowDetailViewModel";
import { Play, ArrowLeft, List, FileText, Brain, Settings2, BarChart3, Pencil, Zap, Trash2, Plus, ExternalLink, User, Database, MessageSquare, Shield, Camera } from "lucide-react";
import StepScreenshots from "../components/StepScreenshots";

interface Step {
  step_index: number;
  action_type: string;
  intent?: string;
  selector_chain?: Array<{ type: string; value: string }>;
  value?: string;
  methods?: Array<Record<string, unknown>> | null;
  success_condition?: { type?: string; value?: string } | null;
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
  workflow_type: string;
  execution_mode?: string;
  version: number;
  steps: Step[];
  analysis: Analysis | null;
  connector_bindings?: ConnectorBinding[];
  config?: { message_template?: string; message_template_updated_at?: string; anti_bot?: boolean };
}

const MESSAGE_TEMPLATE_VARIABLES = [
  "candidate_name",
  "candidate_headline",
  "candidate_score",
  "job_title",
  "company",
  "job_url",
  "job_location",
  "job_description_short",
  "seniority_level",
  "employment_model",
] as const;

const PREVIEW_CTX_SAMPLE: Record<string, string> = {
  candidate_name: "María Pérez",
  candidate_headline: "Senior .NET Developer at Acme",
  candidate_score: "70/100",
  job_title: ".Net/Azure Developer",
  company: "Akurey",
  job_url: "https://example.com/jobs/76",
  job_location: "Costa Rica",
  job_description_short: "Build the platform. Review PRs. Ship.",
  seniority_level: "Senior",
  employment_model: "Remote",
};

function renderTemplatePreview(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key) => {
    const v = ctx[key as string];
    return v ?? m;
  });
}

interface ConnectorSummary {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface ConnectorBinding {
  parameter_key: string;
  connector_id: string;
  source_kind: string;
  template: string;
  job_filters: Record<string, unknown>;
  enabled: boolean;
}

interface BindingPreview {
  parameter_key: string;
  resolved_value?: string;
  source_record?: { job_id?: string; job_title?: string; job_description?: string };
  connector?: { id: string; name: string; type: string };
  target_summary?: string;
  error?: string;
}

export default function WorkflowDetailPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const navigate = useNavigate();
  const { request } = useApi();
  const { data, loading, error, fetchData } = useApiData<WorkflowDetail>();
  const { data: connectors, fetchData: fetchConnectors } = useApiData<ConnectorSummary[]>();
  const [running, setRunning] = useState(false);
  const [showParamModal, setShowParamModal] = useState(false);
  const [showGoalModal, setShowGoalModal] = useState(false);
  const [viewMode, setViewMode] = useState<"literal" | "semantic">("semantic");
  const [runError, setRunError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [messageTemplateDraft, setMessageTemplateDraft] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateSavedAt, setTemplateSavedAt] = useState<string | null>(null);
  const [savingAntiBot, setSavingAntiBot] = useState(false);
  const messageTemplateRef = useRef<HTMLTextAreaElement | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Edit-fields modal state: which extract step is being edited (by step_index).
  const [editingExtractStep, setEditingExtractStep] = useState<Step | null>(null);
  const [bindingDrafts, setBindingDrafts] = useState<Record<string, ConnectorBindingDraft>>({});
  const [bindingPreview, setBindingPreview] = useState<Record<string, BindingPreview>>({});
  const [bindingLoading, setBindingLoading] = useState<Record<string, boolean>>({});
  const [bindingSaving, setBindingSaving] = useState<Record<string, boolean>>({});
  const [bindingErrors, setBindingErrors] = useState<Record<string, string | null>>({});

  // Webhook triggers state
  const [webhookTriggers, setWebhookTriggers] = useState<WebhookTrigger[]>([]);
  const [showAddTrigger, setShowAddTrigger] = useState(false);
  const [newTriggerConnectorId, setNewTriggerConnectorId] = useState("");
  const [triggerSaving, setTriggerSaving] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [triggerNowUrl, setTriggerNowUrl] = useState("");
  const [triggerNowConnectorId, setTriggerNowConnectorId] = useState("");
  const [triggerNowRunning, setTriggerNowRunning] = useState(false);
  const [triggerNowResult, setTriggerNowResult] = useState<{ run_id: string } | null>(null);
  const [triggerNowError, setTriggerNowError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayResult, setReplayResult] = useState<Record<string, string>>({});

  useEffect(() => {
    if (workflowId) fetchData("GET", `/workflows/${workflowId}`);
  }, [workflowId]);

  useEffect(() => {
    fetchConnectors("GET", "/connectors");
  }, [fetchConnectors]);

  const analysis = data?.analysis;

  useEffect(() => {
    const drafts: Record<string, ConnectorBindingDraft> = {};
    for (const binding of data?.connector_bindings || []) {
      drafts[binding.parameter_key] = getBindingDraftForParameter(data || null, binding.parameter_key);
    }
    setBindingDrafts(drafts);
  }, [data?.connector_bindings]);

  useEffect(() => {
    if (!workflowId) return;
    request<unknown>("GET", `/workflows/${workflowId}/webhook-triggers`)
      .then((res) => setWebhookTriggers(normalizeWebhookTriggerResponse(res)))
      .catch(() => {});
  }, [workflowId]);

  useEffect(() => {
    if (webhookTriggers.length > 0 && !triggerNowConnectorId) {
      setTriggerNowConnectorId(webhookTriggers[0].connector_id);
    }
  }, [webhookTriggers]);

  const fetchWebhookTriggers = async () => {
    if (!workflowId) return;
    try {
      const res = await request<unknown>("GET", `/workflows/${workflowId}/webhook-triggers`);
      setWebhookTriggers(normalizeWebhookTriggerResponse(res));
    } catch { /* ignore */ }
  };

  const createWebhookTrigger = async () => {
    if (!workflowId || !newTriggerConnectorId) return;
    setTriggerSaving(true);
    setTriggerError(null);
    try {
      await request("POST", `/workflows/${workflowId}/webhook-triggers`, {
        connector_id: newTriggerConnectorId,
        event_kind: "new_job_position",
      });
      setShowAddTrigger(false);
      setNewTriggerConnectorId("");
      await fetchWebhookTriggers();
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : "Failed to create trigger");
    } finally {
      setTriggerSaving(false);
    }
  };

  const deleteWebhookTrigger = async (triggerId: string) => {
    if (!workflowId) return;
    try {
      await request("DELETE", `/workflows/${workflowId}/webhook-triggers/${triggerId}`);
      await fetchWebhookTriggers();
    } catch { /* ignore */ }
  };

  const replayWebhookTrigger = async (triggerId: string) => {
    if (!workflowId) return;
    setReplayingId(triggerId);
    try {
      const res = await request<{ run_id: string; replayed_from: string | null }>(
        "POST",
        `/workflows/${workflowId}/webhook-triggers/${triggerId}/replay`,
      );
      setReplayResult((prev) => ({ ...prev, [triggerId]: res.run_id }));
    } catch (e) {
      setReplayResult((prev) => ({ ...prev, [triggerId]: `error: ${e instanceof Error ? e.message : "failed"}` }));
    } finally {
      setReplayingId(null);
    }
  };

  const handleTriggerNow = async () => {
    if (!workflowId) return;
    const connId = triggerNowConnectorId || (connectors?.[0]?.id ?? "");
    if (!connId) {
      setTriggerNowError("Select a connector first.");
      return;
    }
    setTriggerNowRunning(true);
    setTriggerNowResult(null);
    setTriggerNowError(null);
    try {
      const res = await request<{ run_id: string; resolved_params: Record<string, string> }>(
        "POST",
        `/workflows/${workflowId}/trigger-now`,
        { connector_id: connId, job_url: triggerNowUrl || null },
      );
      setTriggerNowResult(res);
    } catch (e) {
      setTriggerNowError(e instanceof Error ? e.message : "Trigger failed");
    } finally {
      setTriggerNowRunning(false);
    }
  };

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
    loadSession?: boolean,
  ) => {
    if (!workflowId) return;
    setRunError(null);
    setRunning(true);
    setShowGoalModal(false);
    setShowParamModal(false);
    // All "Run" goes through the DAEMON (one engine) — including LinkedIn
    // workflows (no validation blocking them, per product decision).
    const executionTarget: "browser" | "daemon" = "daemon";
    // Open a placeholder run window immediately. Once the extension reports
    // the run id, we point the same window at /runs/<id>. This is what keeps
    // the run page open for the whole duration of the workflow.
    // Do NOT pass "noopener" — it makes window.open return null, which prevents
    // us from redirecting the tab to the real run URL once the extension responds.
    const runWindow = window.open("/runs/pending", "session-replay-run");
    try {
      const message: {
        type: "DASHBOARD_RUN_WORKFLOW";
        workflowId: string;
        params?: Record<string, string>;
        goal?: string;
        executionTarget?: "browser" | "daemon";
        loadSession?: boolean;
        targetUrl?: string;
        operatorId?: string;
      } = { type: "DASHBOARD_RUN_WORKFLOW", workflowId };
      if (Object.keys(params).length > 0) {
        message.params = params;
      }
      if (goal) {
        message.goal = goal;
      }
      if (executionTarget === "daemon") {
        message.executionTarget = "daemon";
        message.loadSession = !!loadSession;
        if (data?.target_url) message.targetUrl = data.target_url;
      }
      // Routing: the operator id (Settings → stored in this browser's localStorage)
      // tells the backend which daemon to target. LinkedIn workflows override this
      // to Fernanda's daemon server-side. Absent = run waits unclaimed, so warn.
      const operatorId = (localStorage.getItem("sr.operatorId") || "").trim();
      if (operatorId) message.operatorId = operatorId;
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

  const applyEditedExtractStep = async (
    targetStepIndex: number,
    nextValue: string,
    nextShapes: Array<{ key: string; label: string; kind: string; item_keys: string[] | null; extract_hints?: string | null }>,
  ) => {
    if (!workflowId || !data) return;
    const nextSteps = data.steps.map((step) => ({
      action_type: step.action_type,
      intent: step.intent ?? null,
      selector_chain: step.selector_chain ?? null,
      value: step.step_index === targetStepIndex ? nextValue : (step.value ?? null),
      methods:
        step.step_index === targetStepIndex
          ? ([{ kind: "extract_shapes", shapes: nextShapes }] as Array<Record<string, unknown>>)
          : (step.methods ?? null),
      success_condition: step.success_condition ?? null,
      checkpoint: false,
    }));
    await request("PUT", `/workflows/${workflowId}/steps`, nextSteps);
    await fetchData("GET", `/workflows/${workflowId}`);
  };

  const handleRun = async () => {
    if (!workflowId) return;
    setRunError(null);
    if (analysis?.parameters && analysis.parameters.length > 0 && analysis.replay_strategy === "parameterized") {
      const draftsByParamKey: Record<string, ConnectorBindingDraft> = { ...bindingDrafts };
      for (const binding of data?.connector_bindings || []) {
        if (!draftsByParamKey[binding.parameter_key]) {
          draftsByParamKey[binding.parameter_key] = getBindingDraftForParameter(data || null, binding.parameter_key);
        }
      }
      for (const draft of Object.values(draftsByParamKey)) {
        if (draft.connector_id && draft.enabled) {
          await previewConnectorBinding(draft);
        }
      }
      setShowParamModal(true);
      return;
    }
    setShowGoalModal(true);
  };

  const handlePromote = async () => {
    if (!workflowId) return;
    setPromoting(true);
    try {
      await request("POST", `/workflows/${workflowId}/promote`);
      fetchData("GET", `/workflows/${workflowId}`);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Failed to promote workflow");
    }
    setPromoting(false);
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

  const handleRunWithParams = async (params: Record<string, string>, goal?: string, loadSession?: boolean) => {
    await startWorkflowRun(params, goal, "Failed to start parameterized run", loadSession);
  };

  const previewConnectorBinding = async (draft: ConnectorBindingDraft) => {
    const key = draft.parameter_key;
    if (!workflowId || !key || !draft.connector_id) return;
    setBindingLoading((prev) => ({ ...prev, [key]: true }));
    setBindingErrors((prev) => ({ ...prev, [key]: null }));
    try {
      const result = await request<{ preview: {
        parameter_key: string;
        resolved_value: string;
        source_record: { job_id?: string; job_title?: string; job_description?: string };
        connector: { id: string; name: string; type: string };
      } }>(
        "POST",
        `/workflows/${workflowId}/connector-bindings/${key}/preview`,
        {
          connector_id: draft.connector_id,
          source_kind: draft.source_kind,
          template: draft.template,
          job_filters: {},
          enabled: draft.enabled,
        },
      );
      const parameter = analysis?.parameters.find((item) => item.key === key);
      const targetSummary = parameter
        ? parameterConsumerSteps(data || null, parameter).map(formatStepLabel)
        : [];
      setBindingPreview((prev) => ({
        ...prev,
        [key]: {
          ...result.preview,
          target_summary: targetSummary.length > 0 ? targetSummary.join(" | ") : undefined,
        },
      }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to preview connector binding";
      setBindingPreview((prev) => ({ ...prev, [key]: { parameter_key: key, error: message } }));
      setBindingErrors((prev) => ({ ...prev, [key]: message }));
    }
    setBindingLoading((prev) => ({ ...prev, [key]: false }));
  };

  const saveConnectorBinding = async (draft: ConnectorBindingDraft) => {
    const key = draft.parameter_key;
    if (!workflowId || !key) return;
    setBindingSaving((prev) => ({ ...prev, [key]: true }));
    setBindingErrors((prev) => ({ ...prev, [key]: null }));
    try {
      await request("PUT", `/workflows/${workflowId}/connector-bindings/${key}`, {
        connector_id: draft.connector_id,
        source_kind: draft.source_kind,
        template: draft.template,
        job_filters: {},
        enabled: draft.enabled,
      });
      await fetchData("GET", `/workflows/${workflowId}`);
      await previewConnectorBinding(draft);
    } catch (e) {
      setBindingErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : "Failed to save connector binding" }));
    }
    setBindingSaving((prev) => ({ ...prev, [key]: false }));
  };

  const deleteConnectorBinding = async (paramKey: string) => {
    if (!workflowId) return;
    try {
      await request("DELETE", `/workflows/${workflowId}/connector-bindings/${paramKey}`);
      await fetchData("GET", `/workflows/${workflowId}`);
      setBindingDrafts((prev) => { const n = { ...prev }; delete n[paramKey]; return n; });
      setBindingPreview((prev) => { const n = { ...prev }; delete n[paramKey]; return n; });
    } catch (e) {
      setBindingErrors((prev) => ({ ...prev, [paramKey]: e instanceof Error ? e.message : "Failed to remove binding" }));
    }
  };

  const setParameterMode = (paramKey: string, mode: "text" | "connector") => {
    if (mode === "connector") {
      setBindingDrafts((prev) => ({
        ...prev,
        [paramKey]: getBindingDraftForParameter(data || null, paramKey),
      }));
    } else {
      deleteConnectorBinding(paramKey);
    }
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

  const runPrefilledValues = Object.fromEntries(
    (analysis?.parameters || []).map((parameter) => [
      parameter.key,
      bindingPreview[parameter.key]?.resolved_value || parameter.default || "",
    ]),
  );
  const parameterUsageMap = Object.fromEntries(
    (analysis?.parameters || []).map((parameter) => [
      parameter.key,
      parameterConsumerSteps(data, parameter).map(formatStepLabel),
    ]),
  ) as Record<string, string[]>;
  const activeBindingPreviews = Object.values(bindingPreview).filter(
    (p) => (analysis?.parameters || []).some((param) => param.key === p.parameter_key),
  );

  const renderEditExtractButton = (step: Step) => {
    if (step.action_type !== "extract") return null;
    return (
      <button
        type="button"
        onClick={() => setEditingExtractStep(step)}
        className="rounded-md border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary hover:border-accent"
      >
        Edit fields
      </button>
    );
  };

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
            <span
              className={`flex items-center gap-1 font-medium ${data.workflow_type === "system" ? "text-accent" : "text-text-secondary"}`}
            >
              {data.workflow_type === "system" ? <Settings2 size={11} /> : <User size={11} />}
              {data.workflow_type === "system" ? "System" : "My Workflow"}
            </span>
            <ExecutionModeBadge mode={data.execution_mode} />
            {data.status === "archived" && <StatusBadge status="archived" size="sm" />}
            <span>Version {data.version}</span>
            {data.target_url && <span>{data.target_url}</span>}
            {analysis?.replay_strategy && (
              <span className="text-accent">{analysis.replay_strategy} replay</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {data.workflow_type === "user" && data.status !== "archived" && (
            <button
              onClick={handlePromote}
              disabled={promoting}
              className="flex items-center gap-2 px-4 py-2 border border-accent text-accent text-sm rounded-md hover:bg-accent/10 transition-colors disabled:opacity-50"
            >
              {promoting ? "Promoting..." : "Promote to System"}
            </button>
          )}
          <button
            onClick={handleRun}
            disabled={running || data.status === "archived"}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors disabled:opacity-50"
            title={data.status === "archived" ? "Workflow is archived" : ""}
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

      {/* Anti-bot toggle — available on every workflow, persisted in
          config.anti_bot. Opt-in (off by default). Governs the extension's
          human-like pacing on every page; the LinkedIn recruitment daemon is
          always protected regardless of this flag. */}
      <Card className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
              <Shield size={14} /> Human-like execution (anti-bot)
            </h2>
            <p className="text-xs text-text-secondary mt-0.5">
              When on, this workflow runs with human-like pacing — variable dwell and the occasional micro-scroll between steps, on every page. Off (default) runs steps mechanically at the fixed step delay.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={data.config?.anti_bot === true}
            aria-label="Toggle human-like (anti-bot) execution"
            disabled={savingAntiBot}
            onClick={async () => {
              setSavingAntiBot(true);
              try {
                await request<unknown>("PUT", `/workflows/${data.id}`, {
                  config: { ...data.config, anti_bot: !(data.config?.anti_bot === true) },
                });
                fetchData("GET", `/workflows/${data.id}`);
              } finally {
                setSavingAntiBot(false);
              }
            }}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              data.config?.anti_bot === true ? "bg-accent" : "bg-border"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                data.config?.anti_bot === true ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </Card>

      {/* Message Template — visible whenever the workflow has an open_message_drafts step,
          independent of literal/semantic view mode (clones won't have analysis yet). */}
      {data.steps.some((s) => s.action_type === "open_message_drafts") && (() => {
        const stored = data.config?.message_template ?? "";
        const value = messageTemplateDraft ?? stored;
        const draftStepIndex = data.steps.find((s) => s.action_type === "open_message_drafts")?.step_index;
        const dirty = messageTemplateDraft !== null && messageTemplateDraft !== stored;
        const insertToken = (token: string) => {
          const ta = messageTemplateRef.current;
          if (!ta) {
            setMessageTemplateDraft((value || "") + ` {{${token}}}`);
            return;
          }
          const start = ta.selectionStart ?? value.length;
          const end = ta.selectionEnd ?? value.length;
          const next = value.slice(0, start) + `{{${token}}}` + value.slice(end);
          setMessageTemplateDraft(next);
          requestAnimationFrame(() => {
            ta.focus();
            const pos = start + `{{${token}}}`.length;
            ta.setSelectionRange(pos, pos);
          });
        };
        const preview = renderTemplatePreview(value, PREVIEW_CTX_SAMPLE);
        const onSave = async () => {
          setSavingTemplate(true);
          try {
            await request<unknown>("PUT", `/workflows/${data.id}`, {
              // Spread existing config so saving the template doesn't clobber
              // sibling keys (e.g. anti_bot) — the backend full-replaces config.
              config: { ...data.config, message_template: value, message_template_updated_at: new Date().toISOString() },
            });
            setTemplateSavedAt(new Date().toISOString());
            setMessageTemplateDraft(null);
            fetchData("GET", `/workflows/${data.id}`);
          } finally {
            setSavingTemplate(false);
          }
        };
        const previewLen = preview.length;
        const tooLong = previewLen > 300;
        return (
          <Card className="mb-4">
            <div className="flex items-start justify-between mb-3 gap-3">
              <div>
                <h2 className="text-sm font-medium text-text-primary flex items-center gap-2">
                  <MessageSquare size={14} /> Candidate Tabs Template
                </h2>
                <p className="text-xs text-text-secondary mt-0.5">
                  Used by step #{draftStepIndex} — resolves the final candidate list and opens each LinkedIn profile in its own tab. No message is composed or sent.
                </p>
              </div>
              <div className="text-xs text-text-gray">
                {templateSavedAt && !dirty && "saved"}
                {!templateSavedAt && data.config?.message_template_updated_at &&
                  `last updated ${new Date(data.config.message_template_updated_at).toLocaleString()}`}
              </div>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-2">
              {MESSAGE_TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertToken(v)}
                  className="text-[11px] px-2 py-0.5 rounded-md border border-border text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors font-mono"
                  title={`Insert {{${v}}}`}
                >
                  {`{{${v}}}`}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] uppercase text-text-gray mb-1">Template</label>
                <textarea
                  ref={messageTemplateRef}
                  rows={10}
                  value={value}
                  onChange={(e) => setMessageTemplateDraft(e.target.value)}
                  className="w-full bg-bg-elevated border border-border rounded-md p-2.5 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                  spellCheck={false}
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[11px] uppercase text-text-gray">
                    Preview · synthetic candidate
                  </label>
                  <span
                    className="text-[11px] font-mono"
                    style={{ color: tooLong ? "var(--color-error)" : "var(--color-text-gray)" }}
                    title="LinkedIn caps connection-request notes at 300 chars. Drafts longer than this are truncated when pasted."
                  >
                    {previewLen}/300{tooLong ? " · will truncate" : ""}
                  </span>
                </div>
                <div
                  className="w-full bg-bg-elevated border rounded-md p-2.5 text-xs text-text-primary whitespace-pre-wrap min-h-[14rem]"
                  style={{ borderColor: tooLong ? "var(--color-error)" : "var(--color-border)" }}
                >
                  {preview || <span className="text-text-gray italic">(empty template)</span>}
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              {dirty && (
                <button
                  type="button"
                  onClick={() => setMessageTemplateDraft(null)}
                  className="text-xs px-3 py-1.5 rounded-md border border-border text-text-secondary hover:text-text-primary"
                >
                  Discard
                </button>
              )}
              <button
                type="button"
                disabled={!dirty || savingTemplate}
                onClick={onSave}
                className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingTemplate ? "Saving…" : dirty ? "Save template" : "Saved"}
              </button>
            </div>
          </Card>
        );
      })()}

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
            {(analysis.parameters || []).length === 0 ? (
              <div className="text-text-secondary text-sm italic">No parameters configured for this workflow.</div>
            ) : (
              <div className="space-y-5">
                {analysis.parameters.map((param) => {
                  const isConnector = param.type === "string" && !!bindingDrafts[param.key];
                  const draft = bindingDrafts[param.key];
                  const preview = bindingPreview[param.key];
                  const isLoading = bindingLoading[param.key] ?? false;
                  const isSaving = bindingSaving[param.key] ?? false;
                  const bindingErr = bindingErrors[param.key] ?? null;
                  return (
                    <div key={param.key} className="flex flex-col gap-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[#E8EAED] text-sm font-medium flex items-center gap-2">
                          <span>{param.key}</span>
                          {param.required && <span className="text-[#E17055] text-xs">*required</span>}
                          <span
                            className="text-xs px-1.5 py-0.5 rounded-full"
                            style={{
                              backgroundColor: param.confidence > 0.8 ? "rgba(0,184,148,0.15)" : param.confidence > 0.5 ? "rgba(253,203,110,0.15)" : "rgba(225,112,85,0.15)",
                              color: param.confidence > 0.8 ? "#00B894" : param.confidence > 0.5 ? "#FDCB6E" : "#E17055",
                            }}
                          >
                            {Math.round(param.confidence * 100)}%
                          </span>
                        </label>
                        {param.type === "string" && (
                          <div className="flex rounded-md border border-border text-xs overflow-hidden">
                            <button
                              type="button"
                              onClick={() => isConnector && setParameterMode(param.key, "text")}
                              className={`px-2 py-1 transition-colors ${!isConnector ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"}`}
                            >
                              Text
                            </button>
                            <button
                              type="button"
                              onClick={() => !isConnector && setParameterMode(param.key, "connector")}
                              className={`px-2 py-1 border-l border-border transition-colors ${isConnector ? "bg-accent text-white" : "text-text-secondary hover:text-text-primary"}`}
                            >
                              Connector
                            </button>
                          </div>
                        )}
                      </div>
                      {param.description && param.description !== param.key && (
                        <span className="text-xs text-[#9AA0B0]">{param.description}</span>
                      )}
                      {!isConnector ? (
                        <>
                          <input
                            type={param.type === "number" ? "number" : "text"}
                            defaultValue={param.default || ""}
                            readOnly
                            disabled
                            className="rounded-lg border border-[#2D3148] bg-[#2A2E3D] px-3 py-2 text-sm text-[#E8EAED] opacity-60 cursor-not-allowed"
                          />
                          <span className="text-xs text-[#9AA0B0]">Type: {param.type}</span>
                          {(parameterUsageMap[param.key] || []).length > 0 && (
                            <div className="flex flex-wrap gap-2 pt-1">
                              {parameterUsageMap[param.key].map((label) => (
                                <span key={label} className="rounded-full border border-[#2D3148] bg-[#1F2330] px-2 py-1 text-[11px] text-[#9AA0B0]">{label}</span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : draft && (
                        <div className="space-y-3 mt-1 pl-2 border-l-2 border-accent/30">
                          <div>
                            <label className="block text-xs text-text-secondary mb-1">Connector</label>
                            <select
                              value={draft.connector_id}
                              onChange={(e) => setBindingDrafts((prev) => ({ ...prev, [param.key]: { ...prev[param.key], connector_id: e.target.value } }))}
                              className="w-full rounded-md border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
                            >
                              <option value="">Select an Odoo connector</option>
                              {(connectors || []).filter((c) => c.type === "odoo").map((c) => (
                                <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
                              ))}
                            </select>
                          </div>
                          <div className="text-xs text-text-secondary">Source: latest Odoo job</div>
                          <div className="flex flex-wrap gap-2 text-xs">
                            {["{job_title}", "{job_description}"].map((token) => (
                              <button
                                key={token}
                                type="button"
                                onClick={() => setBindingDrafts((prev) => ({ ...prev, [param.key]: { ...prev[param.key], template: `${prev[param.key].template}${prev[param.key].template ? "\n" : ""}${token}` } }))}
                                className="rounded-md border border-border px-2 py-1 text-text-secondary hover:text-text-primary"
                              >
                                Insert {token}
                              </button>
                            ))}
                          </div>
                          <div>
                            <label className="block text-xs text-text-secondary mb-1">Message template</label>
                            <textarea
                              value={draft.template}
                              onChange={(e) => setBindingDrafts((prev) => ({ ...prev, [param.key]: { ...prev[param.key], template: e.target.value } }))}
                              rows={5}
                              className="w-full rounded-md border border-border bg-bg-input px-3 py-2 text-sm text-text-primary"
                            />
                          </div>
                          {bindingErr && (
                            <Banner type="error" title="Connector binding error">{bindingErr}</Banner>
                          )}
                          {preview && !preview.error && (
                            <div className="rounded-md border border-border bg-bg-elevated p-3">
                              <div className="text-xs text-text-secondary mb-1">Latest job: {preview.source_record?.job_title || "Unknown"}</div>
                              <pre className="text-xs text-text-primary whitespace-pre-wrap font-sans">{preview.resolved_value}</pre>
                            </div>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => previewConnectorBinding(draft)}
                              disabled={isLoading || !draft.connector_id}
                              className="px-3 py-2 rounded-md border border-border text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
                            >
                              {isLoading ? "Previewing..." : "Preview latest job"}
                            </button>
                            <button
                              type="button"
                              onClick={() => saveConnectorBinding(draft)}
                              disabled={isSaving || !draft.connector_id}
                              className="px-3 py-2 rounded-md bg-accent text-sm text-white hover:bg-accent-hover disabled:opacity-50"
                            >
                              {isSaving ? "Saving..." : "Save binding"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
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

          {/* Automation Triggers */}
          <Card className="col-span-2">
            <h2 className="text-sm font-medium text-text-primary mb-4 flex items-center gap-2">
              <Zap size={14} /> Automation Triggers
            </h2>

            {/* Existing triggers list */}
            {webhookTriggers.length > 0 && (
              <div className="mb-4 space-y-2">
                {webhookTriggers.map((t) => {
                  const connName = connectors?.find((c) => c.id === t.connector_id)?.name ?? t.connector_id.slice(0, 8);
                  const runId = replayResult[t.id];
                  const isReplaying = replayingId === t.id;
                  return (
                    <div key={t.id} className="rounded-md bg-bg-elevated border border-border text-sm overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${t.enabled ? "bg-success" : "bg-text-gray"}`} />
                          <span className="text-text-primary">{connName}</span>
                          <span className="text-text-secondary">—</span>
                          <span className="text-info text-xs">{t.event_kind}</span>
                          {t.last_fired_at && (
                            <span className="text-text-gray text-xs">
                              last fired {new Date(t.last_fired_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => deleteWebhookTrigger(t.id)}
                          className="text-text-gray hover:text-error transition-colors"
                          title="Remove trigger"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {t.last_job && (
                        <div className="px-3 pb-2 flex items-center justify-between border-t border-border/50 pt-2">
                          <div className="text-xs text-text-secondary truncate max-w-[60%]">
                            Last: <span className="text-text-primary">{t.last_job.job_title}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {runId && !runId.startsWith("error") && (
                              <a href={`/runs/${runId}`} target="_blank" rel="noreferrer"
                                className="flex items-center gap-1 text-xs text-success underline hover:text-success/80">
                                #{runId.slice(0, 8)} <ExternalLink size={10} />
                              </a>
                            )}
                            {runId?.startsWith("error") && (
                              <span className="text-xs text-error">{runId.replace("error: ", "")}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => replayWebhookTrigger(t.id)}
                              disabled={isReplaying}
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs border border-border text-text-secondary hover:text-text-primary hover:border-accent transition-colors disabled:opacity-50"
                            >
                              <Zap size={11} />
                              {isReplaying ? "Replaying…" : "Replay last job"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add trigger */}
            {showAddTrigger ? (
              <div className="mb-4 p-3 rounded-md border border-border bg-bg-elevated space-y-3">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Connector</label>
                  <select
                    value={newTriggerConnectorId}
                    onChange={(e) => setNewTriggerConnectorId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md bg-bg-input border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
                  >
                    <option value="">Select connector…</option>
                    {(connectors || []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Event</label>
                  <div className="px-2 py-1.5 rounded-md bg-bg-input border border-border text-text-secondary text-sm">new_job_position</div>
                </div>
                {triggerError && <p className="text-xs text-error">{triggerError}</p>}
                <div className="flex gap-2">
                  <button type="button" onClick={createWebhookTrigger} disabled={triggerSaving || !newTriggerConnectorId}
                    className="px-3 py-1.5 rounded-md bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-50">
                    {triggerSaving ? "Saving…" : "Save"}
                  </button>
                  <button type="button" onClick={() => { setShowAddTrigger(false); setTriggerError(null); }}
                    className="px-3 py-1.5 rounded-md border border-border text-text-secondary text-xs hover:text-text-primary">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setShowAddTrigger(true)}
                className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary mb-4 transition-colors">
                <Plus size={13} /> Connect webhook
              </button>
            )}

            {/* Manual test */}
            <div className="border-t border-border pt-4">
              <h3 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-3">Manual Test</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Odoo Position URL (optional override)</label>
                  <input
                    type="url"
                    value={triggerNowUrl}
                    onChange={(e) => setTriggerNowUrl(e.target.value)}
                    placeholder="https://odoo.example.com/web#action=recruitment&id=42"
                    className="w-full px-2 py-1.5 rounded-md bg-bg-input border border-border text-text-primary text-sm focus:outline-none focus:border-accent placeholder:text-text-gray"
                  />
                </div>
                <div>
                  <label className="text-xs text-text-secondary block mb-1">Connector</label>
                  <select
                    value={triggerNowConnectorId}
                    onChange={(e) => setTriggerNowConnectorId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md bg-bg-input border border-border text-text-primary text-sm focus:outline-none focus:border-accent"
                  >
                    <option value="">Select connector…</option>
                    {(connectors || []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name} ({c.type})</option>
                    ))}
                  </select>
                </div>
                {triggerNowError && <p className="text-xs text-error">{triggerNowError}</p>}
                {triggerNowResult && (
                  <div className="flex items-center gap-2 text-xs text-success">
                    <span>Run created:</span>
                    <a href={`/runs/${triggerNowResult.run_id}`} target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 underline hover:text-success/80">
                      #{triggerNowResult.run_id.slice(0, 8)} <ExternalLink size={11} />
                    </a>
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleTriggerNow}
                  disabled={triggerNowRunning || !(triggerNowConnectorId || (connectors || []).length > 0)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-50 transition-colors"
                >
                  <Zap size={12} />
                  {triggerNowRunning ? "Triggering…" : "Trigger Now"}
                </button>
              </div>
            </div>
          </Card>

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
                  {step.action_type === "extract" ? (
                    <span className="text-accent text-xs uppercase font-medium flex items-center gap-1">
                      <Database size={11} /> Extract
                    </span>
                  ) : (
                    <span className="text-info text-xs uppercase font-medium">{step.action_type}</span>
                  )}
                  {step.value && step.action_type === "extract" && (
                    <span className="text-text-secondary text-xs">
                      {step.value.split(",").map((f: string) => f.trim()).join(", ")}
                    </span>
                  )}
                  {(analysis?.parameters || [])
                    .filter((parameter) => parameterConsumerSteps(data, parameter).some((candidate) => candidate.step_index === step.step_index))
                    .map((parameter) => (
                      <span
                        key={`${step.step_index}-${parameter.key}`}
                        className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
                      >
                        Uses {parameter.key}
                      </span>
                    ))}
                  {step.action_type !== "extract" && step.selector_chain && step.selector_chain[0] && (
                    <span className="text-text-gray text-xs font-mono truncate max-w-[200px]" title={step.selector_chain[0].value}>
                      {step.selector_chain[0].value}
                    </span>
                  )}
                  {step.value && step.action_type !== "extract" && <span className="text-text-secondary text-xs">"{step.value.slice(0, 50)}"</span>}
                  {step.intent && <span className="text-text-secondary text-xs italic">{step.intent}</span>}
                  {renderEditExtractButton(step)}
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
                  {step.action_type === "extract" ? (
                    <span className="text-accent text-xs uppercase font-medium flex items-center gap-1">
                      <Database size={11} /> Extract
                    </span>
                  ) : (
                    <span className="text-info text-xs uppercase font-medium">{step.action_type}</span>
                  )}
                  {step.value && step.action_type === "extract" && (
                    <span className="text-text-secondary text-xs">
                      {step.value.split(",").map((f: string) => f.trim()).join(", ")}
                    </span>
                  )}
                  {(analysis?.parameters || [])
                    .filter((parameter) => parameterConsumerSteps(data, parameter).some((candidate) => candidate.step_index === step.step_index))
                    .map((parameter) => (
                      <span
                        key={`${step.step_index}-${parameter.key}`}
                        className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
                      >
                        Uses {parameter.key}
                      </span>
                    ))}
                  {step.action_type !== "extract" && step.selector_chain && step.selector_chain[0] && (
                    <span className="text-text-gray text-xs font-mono truncate max-w-[200px]" title={step.selector_chain[0].value}>
                      {step.selector_chain[0].value}
                    </span>
                  )}
                  {step.value && step.action_type !== "extract" && <span className="text-text-secondary text-xs">"{step.value.slice(0, 50)}"</span>}
                  {step.intent && <span className="text-text-secondary text-xs italic">{step.intent}</span>}
                  {renderEditExtractButton(step)}
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

      {/* Recording-time screenshots (captured by the extension while recording) */}
      {workflowId && (
        <Card className="mt-6">
          <h2 className="text-sm font-medium text-text-primary mb-3 flex items-center gap-2">
            <Camera size={14} /> Capturas de grabación
          </h2>
          <StepScreenshots runId={workflowId} artifactType="recording_capture" />
        </Card>
      )}

      {showParamModal && analysis && (
        <RunParameterModal
          parameters={analysis.parameters}
          onRun={handleRunWithParams}
          onCancel={() => setShowParamModal(false)}
          isRunning={running}
          prefilledValues={runPrefilledValues}
          parameterUsageLabels={parameterUsageMap}
          bindingPreviews={activeBindingPreviews}
          includeGoal
          showSessionToggle
          title="Run with Parameters"
          description="Configure runtime parameters before executing this workflow. Connector-backed values will be injected into the recorded steps shown for each parameter."
          goalLabel="Execution goal (optional)"
          goalPlaceholder='e.g. "Use these parameters, then extract the top 10 matching results"'
        />
      )}
      {showGoalModal && (
        <RunParameterModal
          parameters={[]}
          onRun={(_, goal, loadSession) => startWorkflowRun({}, goal, "Failed to start run", loadSession)}
          onSkip={() => startWorkflowRun()}
          onCancel={() => setShowGoalModal(false)}
          isRunning={running}
          includeGoal
          showSessionToggle
          title="Run With Goal"
          description="Optionally set a goal for this run, or run the workflow exactly as recorded."
          goalLabel="What should this run accomplish?"
          goalPlaceholder='e.g. "Extract the first 10 job descriptions from the current results page"'
          startLabel="Run With Goal"
          skipLabel="Run As Recorded"
        />
      )}

      {editingExtractStep && (
        <EditExtractFieldsModal
          step={editingExtractStep}
          onClose={() => setEditingExtractStep(null)}
          onSave={async (nextValue, nextShapes) => {
            await applyEditedExtractStep(editingExtractStep.step_index, nextValue, nextShapes);
            setEditingExtractStep(null);
          }}
          apiBase={(import.meta.env.VITE_API_BASE as string | undefined) || ""}
          apiKey={(import.meta.env.VITE_API_KEY as string | undefined) || ""}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Edit extract fields modal
// ──────────────────────────────────────────────────────────────────────────────

interface EditableShape {
  key: string;
  label: string;
  kind: "scalar" | "string_list" | "record_list" | "unknown";
  item_keys: string[] | null;
  extract_hints?: string | null;
}

interface ExtractStepView {
  step_index: number;
  value?: string;
  methods?: Array<Record<string, unknown>> | null;
  dom_context?: Record<string, unknown> | null;
}

function readShapesFromStep(step: ExtractStepView): EditableShape[] {
  const labels = (step.value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const methodsArray = Array.isArray(step.methods) ? step.methods : [];
  const shapeEntry = methodsArray.find(
    (m) => m && typeof m === "object" && (m as Record<string, unknown>).kind === "extract_shapes",
  ) as { shapes?: EditableShape[] } | undefined;
  const stored = Array.isArray(shapeEntry?.shapes) ? shapeEntry!.shapes! : [];
  if (stored.length > 0) return stored;
  // Legacy steps with no shape metadata: synthesize unknown-shape entries from labels.
  return labels.map((label) => ({
    key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
    label,
    kind: "unknown",
    item_keys: null,
  }));
}

function EditExtractFieldsModal({
  step,
  onClose,
  onSave,
  apiBase,
  apiKey,
}: {
  step: ExtractStepView;
  onClose: () => void;
  onSave: (value: string, shapes: EditableShape[]) => Promise<void>;
  apiBase: string;
  apiKey: string;
}) {
  const [shapes, setShapes] = useState<EditableShape[]>(() => readShapesFromStep(step));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<EditableShape["kind"]>("scalar");

  const snapshots = (step.dom_context && (step.dom_context as Record<string, unknown>)["page_snapshots"]) as
    | Array<{
        section_name?: string;
        page_url?: string;
        page_title?: string;
        visible_text?: string;
        dom_snippet?: string;
        captured_at?: string;
      }>
    | undefined;
  const legacySnapshot = (step.dom_context && (step.dom_context as Record<string, unknown>)["page_snapshot"]) as
    | {
        page_url?: string;
        page_title?: string;
        visible_text?: string;
        dom_snippet?: string;
        captured_at?: string;
      }
    | undefined;
  const snapshot = (Array.isArray(snapshots) && snapshots.length > 0 ? snapshots[0] : legacySnapshot);
  const hasSnapshot = Boolean(
    snapshot && (snapshot.visible_text || snapshot.dom_snippet),
  );

  const pageSnapshots = Array.isArray(snapshots) && snapshots.length > 0 ? snapshots : (snapshot ? [snapshot] : []);

  const removeAt = (idx: number) => setShapes((prev) => prev.filter((_, i) => i !== idx));
  const addManual = () => {
    if (!newLabel.trim()) return;
    const key = newLabel.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (shapes.some((s) => s.key === key)) {
      setError(`A field named "${newLabel}" already exists.`);
      return;
    }
    setShapes((prev) => [...prev, { key, label: newLabel.trim(), kind: newKind, item_keys: null }]);
    setNewLabel("");
    setNewKind("scalar");
    setError(null);
  };

  const handleResuggest = async () => {
    if (!snapshot) return;
    setSuggesting(true);
    setError(null);
    try {
      const base = apiBase || `${window.location.origin.replace(/:\d+$/, ":8081")}/v1`;
      const resp = await fetch(`${base}/workflows/analyze-page-suggestions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "X-API-Key": apiKey } : {}),
        },
        body: JSON.stringify({
          page_url: snapshot.page_url || "",
          page_title: snapshot.page_title || "",
          visible_text: snapshot.visible_text || "",
          dom_snippet: snapshot.dom_snippet || "",
          page_snapshots: pageSnapshots,
        }),
      });
      if (!resp.ok) {
        setError(`Re-analyze failed (${resp.status})`);
        return;
      }
      const body = await resp.json() as {
        suggested_fields: Array<{
          key: string;
          label: string;
          shape?: { kind: EditableShape["kind"]; item_keys: string[] | null; extract_hints?: string | null };
        }>;
      };
      const have = new Set(shapes.map((s) => s.key));
      const additions: EditableShape[] = (body.suggested_fields || [])
        .filter((f) => !have.has(f.key))
        .map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.shape?.kind || "unknown",
          item_keys: f.shape?.item_keys || null,
          extract_hints: f.shape?.extract_hints || null,
        }));
      if (additions.length === 0) {
        setError("No new fields suggested. The current list already covers what the saved page contains.");
      } else {
        setShapes((prev) => [...prev, ...additions]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-analyze failed.");
    } finally {
      setSuggesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const value = shapes.map((s) => s.label).join(", ");
      await onSave(value, shapes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Edit extraction fields</h2>
            <p className="mt-1 text-xs text-text-secondary">
              Step {step.step_index + 1}
              {snapshot?.page_url && <> · {snapshot.page_title || snapshot.page_url}</>}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-text-secondary hover:text-text-primary"
          >
            Close
          </button>
        </div>

        {error && (
          <Banner type="error" title="Heads up">
            <p>{error}</p>
          </Banner>
        )}

        <div className="space-y-3 mt-3">
          {shapes.length === 0 ? (
            <p className="text-sm text-text-secondary">No fields yet. Add some below.</p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {shapes.map((s, idx) => (
                <li key={`${s.key}-${idx}`} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-text-primary">{s.label}</span>
                    {s.kind === "record_list" && (
                      <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">multiple</span>
                    )}
                    {s.kind === "string_list" && (
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">list</span>
                    )}
                    {s.kind === "unknown" && (
                      <span className="rounded bg-bg-elevated px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-secondary">auto</span>
                    )}
                  </div>
                  {s.extract_hints ? (
                    <span className="max-w-md truncate text-[11px] text-text-secondary" title={s.extract_hints}>
                      {s.extract_hints}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => removeAt(idx)}
                    className="text-xs text-text-secondary hover:text-error"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-lg border border-border bg-bg-elevated p-3 space-y-2">
            <p className="text-xs text-text-secondary">Add a field manually</p>
            <div className="flex flex-wrap gap-2">
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Languages"
                className="flex-1 min-w-[160px] rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              />
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as EditableShape["kind"])}
                className="rounded border border-border bg-bg-card px-2 py-1 text-sm text-text-primary"
              >
                <option value="scalar">Text</option>
                <option value="string_list">List of strings</option>
                <option value="record_list">List of records</option>
                <option value="unknown">Auto (let AI choose)</option>
              </select>
              <button
                type="button"
                onClick={addManual}
                className="rounded border border-border px-3 py-1 text-sm text-text-secondary hover:text-text-primary hover:border-accent"
              >
                Add
              </button>
            </div>
          </div>

          {hasSnapshot ? (
            <button
              type="button"
              onClick={handleResuggest}
              disabled={suggesting}
              className="w-full rounded border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-50"
            >
              {suggesting ? "Re-analyzing saved page…" : "Re-suggest from saved page"}
            </button>
          ) : (
            <p className="text-xs text-text-secondary italic">
              No saved page snapshot for this step — re-suggest unavailable. Add fields manually, or
              re-record the workflow with the Analyze-this-page panel during recording.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border px-3 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-accent px-3 py-2 text-sm text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save fields"}
          </button>
        </div>
      </div>
    </div>
  );
}
