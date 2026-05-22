import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import InterventionModal from "../components/InterventionModal";
import Banner from "../components/Banner";
import { useApi } from "../hooks/useApi";
import { logger } from "../lib/logger";
import { formatTime, formatTimeShort } from "../lib/formatTime";
import {
  ArrowLeft, Pause, Play, RotateCcw, Square, ChevronDown, ChevronRight,
  CheckCircle, AlertTriangle, Circle, CircleDot, Loader2, SkipForward,
  Eye, MousePointer, Keyboard, Navigation, Database, RefreshCw
} from "lucide-react";

interface WorkflowStep {
  step_index: number;
  action_type: string;
  intent?: string;
  selector_chain?: Array<{ type: string; value: string }>;
  value?: string;
}

interface ScreenshotMeta {
  sha256: string;
  width: number;
  height: number;
  mime: string;
  byte_size: number;
  trigger: string;
  detail: "low" | "high";
}

interface AIDecisionOutcome {
  id: string;
  step_index: number;
  decision: string;
  confidence: number | null;
  actual_outcome: string | null;
  latency_ms: number | null;
  model: string | null;
  prompt_hash: string | null;
  reasoning: string | null;
  screenshot_meta: ScreenshotMeta | null;
  created_at: string | null;
  resolved_at: string | null;
}

interface GoalProgressPhase {
  name: string;
  goal?: string;
  status: "done" | "active" | "pending";
  start_step?: number;
  end_step?: number;
}

interface GoalProgress {
  workflow_goal?: string | null;
  phases?: GoalProgressPhase[];
  intents?: Array<{ step_index: number; intent: string; status: string }>;
}

interface RunDetail {
  id: string;
  workflow_id: string;
  status: string;
  current_step_index: number;
  total_steps: number;
  pause_reason?: string;
  error_summary?: string;
  started_at?: string;
  ended_at?: string;
  created_at: string;
  goal_progress?: GoalProgress | null;
  resolved_parameters?: Record<string, string>;
  connector_resolution?: Array<{
    parameter_key: string;
    resolved_value: string;
    template?: string;
    connector?: { name?: string; type?: string };
    source_record?: { job_title?: string; job_id?: string; job_description?: string };
  }>;
}

interface WorkflowDetail {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

interface RunEvent {
  id: string;
  event_type: string;
  actor_type: string;
  payload: Record<string, unknown>;
  page_url?: string;
  hash: string;
  previous_hash: string;
  sequence_number: number;
  created_at: string;
}

const stepStatusIcons: Record<string, { icon: typeof CheckCircle; color: string }> = {
  completed: { icon: CheckCircle, color: "var(--color-success)" },
  running: { icon: Loader2, color: "var(--color-info)" },
  recovering: { icon: RefreshCw, color: "var(--color-warning)" },
  waiting: { icon: AlertTriangle, color: "var(--color-warning)" },
  failed: { icon: AlertTriangle, color: "var(--color-error)" },
  pending: { icon: Circle, color: "var(--color-text-gray)" },
};

const actionIcons: Record<string, typeof MousePointer> = {
  click: MousePointer,
  type: Keyboard,
  navigate: Navigation,
  scroll: Eye,
  extract: Database,
  run_script: Database,
  wait: CircleDot,
};

const eventColors: Record<string, string> = {
  run_started: "var(--color-info)",
  run_running: "var(--color-info)",
  run_paused: "var(--color-warning)",
  run_resumed: "var(--color-success)",
  run_completed: "var(--color-success)",
  run_failed: "var(--color-error)",
  run_canceled: "var(--color-text-gray)",
  run_recovering: "var(--color-warning)",
  run_waiting_for_user: "var(--color-warning)",
  checkpoint: "var(--color-accent)",
  step_executed: "var(--color-info)",
  navigate: "var(--color-info)",
  click: "var(--color-text-primary)",
  type: "var(--color-text-primary)",
  recovery_attempt: "var(--color-warning)",
  recovery_success: "var(--color-success)",
  recovery_failure: "var(--color-error)",
  intervention: "var(--color-warning)",
  screenshot: "var(--color-text-secondary)",
  dom_snapshot: "var(--color-text-secondary)",
  extraction: "var(--color-accent)",
  script_executed: "var(--color-accent)",
  recovery_cycle: "var(--color-warning)",
  run_auto_resumed: "var(--color-info)",
  run_auto_completed: "var(--color-success)",
  run_tab_closed: "var(--color-warning)",
};

const CANCELABLE_STATUSES = ["queued", "running", "waiting_for_user", "recovering"];

function getStepStatus(stepIdx: number, currentIdx: number, runStatus: string, events: RunEvent[]): string {
  if (["completed"].includes(runStatus) && stepIdx < currentIdx) return "completed";
  if (["failed", "canceled"].includes(runStatus) && stepIdx < currentIdx) return "completed";

  const stepEvents = events.filter(
    (e) => e.event_type === "step_executed" && (e.payload as any)?.step_index === stepIdx
  );
  if (stepEvents.length > 0) {
    const last = stepEvents[stepEvents.length - 1];
    if ((last.payload as any)?.success === true) return "completed";
    if ((last.payload as any)?.success === false) return "failed";
  }

  if (stepIdx === currentIdx) {
    if (runStatus === "waiting_for_user") return "waiting";
    if (runStatus === "recovering") return "recovering";
    if (runStatus === "running" || runStatus === "queued") return "running";
    if (runStatus === "failed") return "failed";
  }

  if (stepIdx > currentIdx) return "pending";
  return "completed";
}

function formatDuration(start?: string, end?: string): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function truncatePayload(payload: Record<string, unknown>, maxLen = 80): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen) + "...";
}

function formatEventSummary(event: RunEvent): string {
  const payload = event.payload || {};
  const decisionContext = (payload.decision_context as Record<string, unknown> | undefined) || {};
  const stepIndex = typeof payload.step_index === "number" ? payload.step_index + 1 : null;

  if (event.event_type === "agent_decision") {
    const decision = String(payload.decision || "unknown");
    const pauseReason = payload.pause_reason ? `pause=${String(payload.pause_reason)}` : "";
    const reasonCode = decisionContext.reason_code ? `code=${String(decisionContext.reason_code)}` : "";
    const origin = decisionContext.origin ? `origin=${String(decisionContext.origin)}` : "";
    const fallback = decisionContext.fallback ? `fallback=${String(decisionContext.fallback)}` : "";
    const strategy = decisionContext.strategy ? `strategy=${String(decisionContext.strategy)}` : "";
    const parts = [stepIndex ? `step ${stepIndex}` : "", decision, reasonCode, origin, fallback, strategy, pauseReason]
      .filter(Boolean);
    return parts.join(" · ");
  }

  if (event.event_type === "recovery_cycle") {
    const kind = String(payload.kind || "cycle");
    const trigger = payload.trigger ? `trigger=${String(payload.trigger)}` : "";
    const cycle = typeof payload.cycle === "number" ? `cycle=${payload.cycle}` : "";
    const strategy = payload.strategy ? `strategy=${String(payload.strategy)}` : "";
    return [kind, trigger, cycle, strategy].filter(Boolean).join(" · ");
  }

  if (event.event_type === "script_executed") {
    const success = payload.success === true ? "success" : "failure";
    const error = payload.error ? `error=${String(payload.error).slice(0, 80)}` : "";
    const duration = typeof payload.duration_ms === "number" ? `${payload.duration_ms}ms` : "";
    const resultType = payload.result_type ? `result=${String(payload.result_type)}` : "";
    return [stepIndex ? `step ${stepIndex}` : "", success, duration, resultType, error].filter(Boolean).join(" · ");
  }

  if (event.event_type === "run_auto_resumed") {
    const attempt = payload.attempt ? `attempt ${String(payload.attempt)}` : "";
    const ops = Array.isArray(payload.ops) ? `${payload.ops.length} ops` : "";
    return [attempt, ops].filter(Boolean).join(" · ") || "auto resume";
  }

  if (event.event_type === "step_executed") {
    const success = payload.success === true ? "success" : payload.success === false ? "failure" : "";
    const error = payload.error ? String(payload.error).slice(0, 90) : "";
    return [stepIndex ? `step ${stepIndex}` : "", success, error].filter(Boolean).join(" · ");
  }

  return truncatePayload(payload);
}

function describeEventType(eventType: string): string {
  const map: Record<string, string> = {
    run_started: "Started",
    run_running: "Running",
    run_paused: "Paused",
    run_resumed: "Resumed",
    run_completed: "Completed",
    run_failed: "Failed",
    run_canceled: "Canceled",
    run_recovering: "Recovering",
    run_waiting_for_user: "Waiting for user",
    checkpoint: "Checkpoint",
    step_executed: "Step executed",
    recovery_attempt: "Recovery attempt",
    recovery_success: "Recovery succeeded",
    recovery_failure: "Recovery failed",
    recovery_cycle: "Recovery cycle",
    run_auto_resumed: "Auto resumed",
    run_auto_completed: "Auto completed",
    run_tab_closed: "Tab closed",
    extraction: "Data extraction",
    script_executed: "Script executed",
    intervention: "Human intervention",
  };
  return map[eventType] || eventType.replace(/_/g, " ");
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { request } = useApi();

  const [run, setRun] = useState<RunDetail | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  // Workstream F: per-step decision outcomes — used to render the Vision chip
  // when the AI received a screenshot on a step's decision. Keyed by step_index
  // so the timeline can do an O(1) lookup. Records keep the latest outcome
  // per step (later decisions overwrite earlier ones in the same run).
  const [outcomesByStep, setOutcomesByStep] = useState<Record<number, AIDecisionOutcome>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [showIntervention, setShowIntervention] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [activeTab, setActiveTab] = useState<"timeline" | "events" | "extraction">("timeline");

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasShownIntervention = useRef<string | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const activeStepRef = useRef<HTMLDivElement>(null);

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await request<RunDetail>("GET", `/runs/${runId}`);
      setRun(data);
      return data;
    } catch (err) {
      if (!loading) setError(err instanceof Error ? err.message : "Failed to load run");
      return null;
    }
  }, [runId, request, loading]);

  const fetchEvents = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await request<RunEvent[]>("GET", `/runs/${runId}/events?limit=500`);
      setEvents(data);
    } catch {}
  }, [runId, request]);

  const fetchOutcomes = useCallback(async () => {
    if (!runId || runId === "pending") return;
    try {
      const data = await request<AIDecisionOutcome[]>(
        "GET", `/agent/${runId}/outcomes?limit=500`,
      );
      // Keep the latest outcome per step. Backend returns ascending by
      // created_at, so a later assignment naturally wins on conflict.
      const byStep: Record<number, AIDecisionOutcome> = {};
      for (const o of data) byStep[o.step_index] = o;
      setOutcomesByStep(byStep);
    } catch {
      /* Best-effort — vision chip is non-critical UI. */
    }
  }, [runId, request]);

  const fetchWorkflow = useCallback(async (workflowId: string) => {
    try {
      const data = await request<WorkflowDetail>("GET", `/workflows/${workflowId}`);
      setWorkflow(data);
    } catch {}
  }, [request]);

  useEffect(() => {
    if (!runId) return;
    // Placeholder route hit from WorkflowDetailPage while the extension is
    // still creating the run. Stay in loading until the workflow page navs
    // us to the real /runs/<id>.
    if (runId === "pending") {
      setLoading(true);
      return;
    }
    setLoading(true);
    Promise.all([fetchRun(), fetchEvents(), fetchOutcomes()]).finally(() => setLoading(false));
  }, [runId]);

  useEffect(() => {
    if (run?.workflow_id && !workflow) {
      fetchWorkflow(run.workflow_id);
    }
  }, [run?.workflow_id, workflow, fetchWorkflow]);

  useEffect(() => {
    if (!run) return;
    const isTerminal = ["completed", "failed", "canceled"].includes(run.status);
    if (isTerminal) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    const intervalMs = run.status === "running" || run.status === "recovering" ? 800 : 3000;
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      fetchRun();
      fetchEvents();
      fetchOutcomes();
    }, intervalMs);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [run?.status, runId]);

  useEffect(() => {
    if (
      run?.status === "waiting_for_user" &&
      run.pause_reason !== "tab_closed" &&
      hasShownIntervention.current !== run.id
    ) {
      hasShownIntervention.current = run.id;
      setShowIntervention(true);
    }
    if (run?.status !== "waiting_for_user") {
      setShowIntervention(false);
      hasShownIntervention.current = null;
    }
  }, [run?.status, run?.id, run?.pause_reason]);

  // Auto-scroll the active step into view whenever it advances.
  useEffect(() => {
    if (activeStepRef.current) {
      activeStepRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [run?.current_step_index]);

  const handleAction = async (action: string, endpoint: string) => {
    setActionLoading(action);
    setError(null);
    try {
      await request("POST", endpoint);
      const updated = await fetchRun();
      await fetchEvents();
      if (updated?.workflow_id && !workflow) {
        fetchWorkflow(updated.workflow_id);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed to ${action}`;
      logger.error("RunDetailPage", action, { run_id: runId, endpoint }, err instanceof Error ? err : undefined);
      setError(msg);
    }
    setActionLoading(null);
  };

  const handleRerun = async () => {
    if (!runId) return;
    // Open a blank tab synchronously inside the user-gesture so pop-up
    // blockers don't suppress it. We'll point the new tab at the new run URL
    // once the API responds.
    // Note: cannot use "noopener" here — when set, window.open returns null and
    // we'd lose the ability to redirect the tab once the API responds.
    const newTab = window.open("about:blank", "_blank");
    setActionLoading("rerun");
    setError(null);
    try {
      const data = await request<{ id: string }>("POST", `/runs/${runId}/rerun`);
      const newUrl = `${window.location.origin}/runs/${data.id}`;
      if (newTab && !newTab.closed) {
        newTab.location.href = newUrl;
      } else {
        // Pop-up was blocked or closed — fall back to same-tab navigation.
        navigate(`/runs/${data.id}`);
      }
    } catch (err) {
      if (newTab && !newTab.closed) newTab.close();
      const msg = err instanceof Error ? err.message : "Failed to re-run";
      logger.error("RunDetailPage", "rerun", { run_id: runId }, err instanceof Error ? err : undefined);
      setError(msg);
    }
    setActionLoading(null);
  };

  const handleRetry = async () => {
    if (!runId || !run) return;
    setActionLoading("retry");
    setError(null);
    try {
      if (run.status === "failed") {
        await request("POST", `/runs/${runId}/recover`, { step_index: run.current_step_index, error: run.error_summary || "Manual retry" });
      }
      await fetchRun();
      await fetchEvents();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to retry";
      logger.error("RunDetailPage", "retry", { run_id: runId }, err instanceof Error ? err : undefined);
      setError(msg);
    }
    setActionLoading(null);
  };

  const toggleEventExpand = (eventId: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const steps: WorkflowStep[] = workflow?.steps || [];
  const stepsFromRun = run?.total_steps
    ? Array.from({ length: run.total_steps }, (_, i) => {
        const existing = steps.find((s) => s.step_index === i);
        return existing || { step_index: i, action_type: "unknown" };
      })
    : [];

  const displaySteps = steps.length > 0 ? steps : stepsFromRun;

  const recoveryEvents = useMemo(
    () => events.filter((e) => ["recovery_attempt", "recovery_success", "recovery_failure"].includes(e.event_type)),
    [events]
  );
  const extractionEvents = useMemo(
    () => events.filter((e) => e.event_type === "extraction"),
    [events]
  );

  const currentStep = run && displaySteps.length > 0
    ? displaySteps[Math.min(run.current_step_index, displaySteps.length - 1)]
    : null;

  const currentStepStatus = run ? getStepStatus(run.current_step_index, run.current_step_index, run.status, events) : "pending";

  if (loading && !run) {
    const isPending = runId === "pending";
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-4 bg-bg-elevated rounded animate-pulse" />
          <div className="w-40 h-6 bg-bg-elevated rounded animate-pulse" />
        </div>
        {isPending ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <Loader2 size={32} className="text-accent animate-spin" />
            <p className="text-text-primary font-medium">Starting workflow…</p>
            <p className="text-text-secondary text-sm">Waiting for the extension to launch the run</p>
          </div>
        ) : (
          <>
            <Card>
              <div className="space-y-3">
                <div className="h-4 bg-bg-elevated rounded animate-pulse w-3/4" />
                <div className="h-4 bg-bg-elevated rounded animate-pulse w-1/2" />
                <div className="h-4 bg-bg-elevated rounded animate-pulse w-2/3" />
              </div>
            </Card>
            <div className="mt-4 space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-bg-elevated rounded animate-pulse" />
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  if (error && !run) {
    return (
      <div>
        <button onClick={() => navigate("/runs")} className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors">
          <ArrowLeft size={14} /> Back to Runs
        </button>
        <Banner type="error" title="Error loading run" action={
          <button
            onClick={() => { setError(null); setLoading(true); Promise.all([fetchRun(), fetchEvents(), fetchOutcomes()]).finally(() => setLoading(false)); }}
            className="text-sm text-accent hover:text-accent-hover"
          >
            Retry
          </button>
        }>
          {error}
        </Banner>
      </div>
    );
  }

  if (!run) return null;

  const isRunning = run.status === "running";
  const isPaused = run.status === "waiting_for_user";
  const isTabClosed = isPaused && run.pause_reason === "tab_closed";
  const isRecovering = run.status === "recovering";
  const isCancelable = CANCELABLE_STATUSES.includes(run.status);
  const isTerminal = ["completed", "failed", "canceled"].includes(run.status);
  const progressPct = run.total_steps > 0 ? Math.round((run.current_step_index / run.total_steps) * 100) : 0;

  const interventionStep = run.status === "waiting_for_user" ? currentStep : null;
  const interventionReason = run.pause_reason || run.error_summary || "The workflow was paused";

  return (
    <div>
      <button onClick={() => navigate("/runs")} className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors">
        <ArrowLeft size={14} /> Back to Runs
      </button>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold text-text-primary">
              {workflow ? workflow.name : <span className="font-mono">#{run.id.slice(0, 8)}</span>}
            </h1>
            <StatusBadge status={run.status as any} size="md" />
          </div>
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            {workflow && <span className="font-mono text-text-gray">#{run.id.slice(0, 8)}</span>}
            <span>Step {run.current_step_index + 1} of {run.total_steps}</span>
            {run.started_at && <span>Started {formatTime(run.started_at)}</span>}
            {run.ended_at && <span>Ended {formatTime(run.ended_at)}</span>}
            {!run.ended_at && run.started_at && (
              <span>Duration {formatDuration(run.started_at)}</span>
            )}
          </div>
          {run.error_summary && (
            <div className="mt-2 text-xs text-error bg-error/10 border border-error/20 rounded px-3 py-1.5 max-w-xl">
              {run.error_summary}
            </div>
          )}
        </div>
      </div>

      {error && !isPaused && (
        <div className="mb-4">
          <Banner type="error" title="Action failed">{error}</Banner>
        </div>
      )}

      {isTabClosed && (
        <div className="mb-4">
          <Banner type="warning" title="Tab was closed">
            The browser tab running this workflow was closed. Resume is unavailable — use Re-run to start a fresh execution.
          </Banner>
        </div>
      )}

      {/* Progress Bar */}
      <Card className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {isRunning && <Loader2 size={14} className="text-info animate-spin" />}
            {isPaused && <AlertTriangle size={14} className="text-warning" />}
            {isRecovering && <RefreshCw size={14} className="text-warning animate-spin" />}
            <span className="text-sm text-text-secondary">
              {isRunning && currentStep ? `Executing: ${currentStep.action_type}` : ""}
              {isTabClosed ? "Tab closed — re-run to continue" : ""}
              {isPaused && !isTabClosed ? "Waiting for your action" : ""}
              {isRecovering ? "Attempting recovery..." : ""}
              {run.status === "completed" ? "Completed" : ""}
              {run.status === "failed" ? "Failed" : ""}
              {run.status === "canceled" ? "Canceled" : ""}
              {run.status === "queued" ? "Queued" : ""}
            </span>
          </div>
          <span className="text-xs text-text-gray">{progressPct}%</span>
        </div>
        <div className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPct}%`,
              background: run.status === "failed" ? "var(--color-error)" : isTerminal ? "var(--color-success)" : isPaused ? "var(--color-warning)" : "var(--color-accent)",
            }}
          />
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {(isRunning || isRecovering) && (
            <button
              onClick={() => handleAction("pause", `/runs/${runId}/pause`)}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-50"
            >
              <Pause size={14} /> {actionLoading === "pause" ? "..." : "Pause"}
            </button>
          )}
          {isPaused && !isTabClosed && (
            <>
              <button
                onClick={() => handleAction("resume", `/runs/${runId}/resume`)}
                disabled={actionLoading !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                <Play size={14} /> {actionLoading === "resume" ? "..." : "Resume"}
              </button>
              <button
                onClick={() => handleAction("resume_ai", `/agent/${runId}/resume`)}
                disabled={actionLoading !== null}
                title="Ask the AI to propose a new plan and resume autonomously"
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25 transition-colors disabled:opacity-50"
              >
                <RotateCcw size={14} /> {actionLoading === "resume_ai" ? "Asking AI..." : "Resume with AI"}
              </button>
            </>
          )}
          {isCancelable && (
            <button
              onClick={() => handleAction("stop", `/runs/${runId}/cancel`)}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-text-gray hover:text-error hover:border-error transition-colors disabled:opacity-50"
            >
              <Square size={14} /> {actionLoading === "stop" ? "..." : "Stop"}
            </button>
          )}
          {run.status === "failed" && (
            <button
              onClick={handleRetry}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-warning/20 text-warning border border-warning/30 hover:bg-warning/30 transition-colors disabled:opacity-50"
            >
              <RotateCcw size={14} /> {actionLoading === "retry" ? "Retrying..." : "Retry from failure"}
            </button>
          )}
          {(isTerminal || isTabClosed) && (
            <button
              onClick={handleRerun}
              disabled={actionLoading !== null}
              title="Create a new run that re-executes this run's plan"
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              <RotateCcw size={14} /> {actionLoading === "rerun" ? "Re-running..." : "Re-run"}
            </button>
          )}
          <div className="flex-1" />
          {currentStep && (isRunning || (isPaused && !isTabClosed)) && (
            <button
              onClick={() => handleAction("skip", `/runs/${runId}/advance_step`)}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <SkipForward size={14} /> Skip Step
            </button>
          )}
        </div>
      </Card>

      {/* Current Step Detail */}
      {currentStep && !isTerminal && (
        <div className={`mb-6 bg-bg-surface rounded-lg border-2 p-4 ${
          isPaused ? "border-warning" : isRecovering ? "border-warning" : "border-accent"
        }`}>
          <div className="flex items-center gap-2 mb-2">
            {isRunning && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
            )}
            {(() => {
              const ActionIcon = actionIcons[currentStep.action_type] || CircleDot;
              return <ActionIcon size={14} style={{ color: isPaused ? "var(--color-warning)" : "var(--color-accent)" }} />;
            })()}
            <h2 className="text-sm font-medium text-text-primary">
              Step {run.current_step_index + 1}: <span className="uppercase text-info">{currentStep.action_type}</span>
            </h2>
            <StatusBadge status={currentStepStatus as any} size="sm" />
          </div>
          {currentStep.intent && (
            <p className="text-xs text-text-secondary italic mb-2">{currentStep.intent}</p>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            {currentStep.selector_chain && currentStep.selector_chain.length > 0 && (
              <div>
                <span className="text-text-gray mr-1">Selector:</span>
                <code className="text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                  {currentStep.selector_chain.map((s) => `${s.type}=${s.value}`).join(" › ")}
                </code>
              </div>
            )}
            {currentStep.value && (
              <div>
                <span className="text-text-gray mr-1">Value:</span>
                <code className="text-text-primary bg-bg-elevated px-1.5 py-0.5 rounded">
                  "{currentStep.value.slice(0, 80)}{currentStep.value.length > 80 ? "..." : ""}"
                </code>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-bg-surface rounded-lg p-1 border border-border">
        {(["timeline", "events", "extraction"] as const).map((tab) => {
          const count = tab === "events" ? events.length : tab === "extraction" ? extractionEvents.length : displaySteps.length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize ${
                activeTab === tab
                  ? "bg-accent text-white"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {tab} {count > 0 && <span className="opacity-70">({count})</span>}
            </button>
          );
        })}
      </div>

      {/* Phase 6: Goal Progress ribbon — phases derived from semantic analysis */}
      {run.goal_progress?.phases && run.goal_progress.phases.length > 0 && (
        <Card className="mb-4">
          {run.goal_progress.workflow_goal && (
            <div className="text-xs text-text-gray mb-2">Goal: <span className="text-text-secondary">{run.goal_progress.workflow_goal}</span></div>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            {run.goal_progress.phases.map((ph, idx) => {
              const color = ph.status === "done" ? "var(--color-success)"
                : ph.status === "active" ? "var(--color-info)"
                : "var(--color-text-gray)";
              const marker = ph.status === "done" ? "✓" : ph.status === "active" ? "▶" : "·";
              return (
                <div
                  key={`${ph.name}-${idx}`}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs"
                  style={{ borderLeft: `3px solid ${color}`, background: "var(--color-bg-elevated)" }}
                  title={ph.goal}
                >
                  <span style={{ color }}>{marker}</span>
                  <span className={ph.status === "active" ? "font-medium text-text-primary" : "text-text-secondary"}>
                    {ph.name}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {run.connector_resolution && run.connector_resolution.length > 0 && (
        <Card className="mb-4">
          <h2 className="text-sm font-medium text-text-primary mb-3">Connector Resolution</h2>
          <div className="space-y-3">
            {run.connector_resolution.map((resolution) => (
              <div key={resolution.parameter_key} className="rounded-md border border-border bg-bg-elevated p-3">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <div className="text-sm text-text-primary">{resolution.parameter_key}</div>
                  {resolution.connector?.name && (
                    <div className="text-xs text-text-secondary">
                      {resolution.connector.name}
                      {resolution.connector.type ? ` (${resolution.connector.type})` : ""}
                    </div>
                  )}
                </div>
                {resolution.source_record?.job_title && (
                  <div className="text-xs text-text-secondary mb-2">
                    Latest job: {resolution.source_record.job_title}
                    {resolution.source_record.job_id ? ` (#${resolution.source_record.job_id})` : ""}
                  </div>
                )}
                <div className="text-xs text-text-primary whitespace-pre-wrap break-words">
                  {resolution.resolved_value}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Step Timeline */}
      {activeTab === "timeline" && (
        <Card>
          {displaySteps.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-text-secondary text-sm">No steps available</p>
              <p className="text-text-gray text-xs mt-1">Steps will appear when the workflow is loaded.</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {displaySteps.map((step) => {
                const status = getStepStatus(step.step_index, run.current_step_index, run.status, events);
                const cfg = stepStatusIcons[status] || stepStatusIcons.pending;
                const Icon = cfg.icon;
                const isActive = step.step_index === run.current_step_index && !isTerminal;
                const stepEvents = events.filter(
                  (e) => e.event_type === "step_executed" && (e.payload as any)?.step_index === step.step_index
                );
                const lastStepEvent = stepEvents.length > 0 ? stepEvents[stepEvents.length - 1] : null;
                const stepFailed = lastStepEvent && (lastStepEvent.payload as any)?.success === false;

                return (
                  <div
                    key={step.step_index}
                    ref={isActive ? activeStepRef : null}
                    className={`flex items-center gap-3 py-2 px-3 rounded-md text-sm transition-colors ${
                      isActive
                        ? "bg-accent/10 border border-accent/30 shadow-[0_0_0_1px_var(--color-accent)]"
                        : "hover:bg-bg-elevated"
                    }`}
                  >
                    <Icon
                      size={14}
                      style={{ color: cfg.color }}
                      className={status === "running" || status === "recovering" ? "animate-spin" : ""}
                    />
                    <span className="text-text-gray text-xs w-5 flex-shrink-0">{step.step_index + 1}</span>
                    <span className="text-info text-xs uppercase font-medium w-16 flex-shrink-0">
                      {step.action_type}
                    </span>
                    {step.intent && (
                      <span className="text-text-secondary text-xs truncate flex-1">{step.intent}</span>
                    )}
                    {!step.intent && step.selector_chain && step.selector_chain[0] && (
                      <code className="text-text-gray text-xs font-mono truncate flex-1">{step.selector_chain[0].value}</code>
                    )}
                    {!step.intent && !step.selector_chain?.length && (
                      <span className="text-text-gray text-xs flex-1" />
                    )}
                    {step.value && (
                      <span className="text-text-gray text-xs font-mono truncate max-w-[120px]">
                        "{step.value.slice(0, 30)}"
                      </span>
                    )}
                    {outcomesByStep[step.step_index]?.screenshot_meta && (
                      (() => {
                        const m = outcomesByStep[step.step_index].screenshot_meta!;
                        return (
                          <span
                            className="text-xs px-2 py-0.5 rounded bg-accent/20 text-accent flex items-center gap-1 flex-shrink-0"
                            title={`Screenshot: ${m.width}×${m.height} (${m.detail}, ${m.byte_size}B, trigger=${m.trigger})`}
                            aria-label={`Vision: AI received a screenshot for this decision (${m.detail} detail, ${m.byte_size} bytes, trigger ${m.trigger})`}
                            data-testid={`vision-chip-step-${step.step_index}`}
                          >
                            <Eye size={10} aria-hidden />
                            Vision
                          </span>
                        );
                      })()
                    )}
                    <span className="text-xs flex-shrink-0" style={{ color: cfg.color }}>
                      {status === "completed" ? "Done" : status === "running" ? "Running" : status === "recovering" ? "Healing" : status === "waiting" ? "Paused" : status === "failed" ? "Failed" : ""}
                    </span>
                    {stepFailed && (
                      <span className="text-xs text-error truncate max-w-[150px]">{String((lastStepEvent?.payload as any)?.error || "").slice(0, 50)}</span>
                    )}
                  </div>
                );
              })}
              <div ref={timelineEndRef} />
            </div>
          )}
        </Card>
      )}

      {/* Event Feed */}
      {activeTab === "events" && (
        <Card>
          <h2 className="text-sm font-medium text-text-primary mb-3">
            Event Feed {events.length > 0 && <span className="text-text-gray font-normal">({events.length})</span>}
          </h2>
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-text-secondary text-sm">No events yet</p>
              <p className="text-text-gray text-xs mt-1">Events will appear here as the run executes.</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {events.map((event) => {
                const isExpanded = expandedEvents.has(event.id);
                return (
                  <div key={event.id}>
                    <button
                      onClick={() => toggleEventExpand(event.id)}
                      className="w-full flex items-center gap-3 py-2 px-3 rounded-md text-sm hover:bg-bg-elevated transition-colors text-left"
                    >
                      <span className="text-text-gray text-xs flex-shrink-0 w-16">{formatTimeShort(event.created_at)}</span>
                      <span
                        className="text-xs font-medium uppercase flex-shrink-0 w-32 truncate"
                        style={{ color: eventColors[event.event_type] || "var(--color-text-primary)" }}
                      >
                        {describeEventType(event.event_type)}
                      </span>
                      <span className="text-text-gray text-xs flex-shrink-0 w-14">{event.actor_type}</span>
                      <span className="text-text-secondary text-xs font-mono truncate flex-1">
                        {formatEventSummary(event)}
                      </span>
                      {event.payload && Object.keys(event.payload).length > 0 && (
                        <span className="text-text-gray text-xs flex-shrink-0">{isExpanded ? "▲" : "▼"}</span>
                      )}
                    </button>
                    {isExpanded && event.payload && Object.keys(event.payload).length > 0 && (
                      <div className="ml-[188px] mr-3 mb-2 p-3 bg-bg-elevated rounded-md">
                        <pre className="text-text-secondary text-xs font-mono whitespace-pre-wrap break-all">
                          {JSON.stringify(event.payload, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Extraction Data */}
      {activeTab === "extraction" && (
        <Card>
          {extractionEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-text-secondary text-sm">No extraction data yet</p>
              <p className="text-text-gray text-xs mt-1">Extracted data will appear here when the run processes extraction steps.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {extractionEvents.map((event) => {
                const records = (event.payload.data as unknown[]) || [];
                if (records.length === 0) return null;
                const keys = Object.keys(records[0] as Record<string, unknown> || {});
                return (
                  <div key={event.id} className="overflow-x-auto">
                    <h3 className="text-xs text-text-secondary mb-1">Step {(event.payload.step_index as number) + 1} — {records.length} records</h3>
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-border">
                          {keys.map((k) => (
                            <th key={k} className="text-left py-2 px-2 text-text-secondary font-medium capitalize">{k.replace(/_/g, " ")}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((rec, ri) => (
                          <tr key={ri} className="border-b border-border/30 hover:bg-bg-elevated">
                            {keys.map((k) => (
                              <td key={k} className="py-1.5 px-2 text-text-primary font-mono max-w-[300px] truncate">
                                {String((rec as Record<string, unknown>)[k] || "").slice(0, 100)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Recovery Attempts (always visible when present) */}
      {recoveryEvents.length > 0 && (
        <Card className="mt-4">
          <button
            onClick={() => setShowRecovery(!showRecovery)}
            className="flex items-center gap-2 text-sm text-warning font-medium w-full text-left"
          >
            {showRecovery ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Recovery Attempts ({recoveryEvents.length})
          </button>
          {showRecovery && (
            <div className="mt-3 space-y-2 border-t border-border pt-3">
              {recoveryEvents.map((event) => (
                <div key={event.id} className="flex items-center gap-3 text-xs text-text-secondary py-1">
                  <span className="text-text-gray">{formatTimeShort(event.created_at)}</span>
                  <span
                    className="font-medium"
                    style={{ color: eventColors[event.event_type] || "var(--color-text-primary)" }}
                  >
                    {event.event_type === "recovery_attempt" ? "Attempt" :
                     event.event_type === "recovery_success" ? "Success" : "Failed"}
                  </span>
                  {event.payload && Object.keys(event.payload).length > 0 && (
                    <span className="font-mono truncate max-w-[300px]">{truncatePayload(event.payload)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Intervention Modal */}
      {showIntervention && run.status === "waiting_for_user" && interventionStep && (
        <InterventionModal
          runId={run.id}
          runName={workflow?.name}
          blockedStep={run.current_step_index + 1}
          blockedStepName={interventionStep.intent || interventionStep.action_type || "Unknown step"}
          explanation={interventionReason}
          instructions={[
            "Review the current browser state.",
            "Complete any required action (e.g., CAPTCHA, form input).",
            'Click "Continue Workflow" to resume from where it paused.',
          ]}
          onClose={() => setShowIntervention(false)}
          onReview={() => { setShowIntervention(false); setActiveTab("timeline"); }}
          onResolved={() => { setShowIntervention(false); fetchRun(); fetchEvents(); }}
        />
      )}
    </div>
  );
}
