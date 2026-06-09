import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import InterventionModal from "../components/InterventionModal";
import Banner from "../components/Banner";
import StepScreenshots from "../components/StepScreenshots";
import FlowManifest from "../components/FlowManifest";
import { useApi } from "../hooks/useApi";
import { logger } from "../lib/logger";
import { formatTime, formatTimeShort } from "../lib/formatTime";
import { formatDuration, formatEventSummary, getStepStatus, truncatePayload } from "./viewmodels/runDetailViewModel";
import {
  ArrowLeft, Play, RotateCcw, Square, ChevronDown, ChevronRight,
  CheckCircle, AlertTriangle, Circle, CircleDot, Loader2, SkipForward,
  Eye, MousePointer, Keyboard, Navigation, Database, RefreshCw, Copy, Check
} from "lucide-react";

// Recursive JSON value renderer used by the Extraction tab. Walks arrays
// and plain objects so nested records show their real structure instead of
// "[object Object]". Strings, numbers, booleans, and nulls render inline.
function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) {
    return <span className="text-text-gray italic">—</span>;
  }
  if (typeof value === "string") {
    if (value === "") return <span className="text-text-gray italic">""</span>;
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-accent">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-text-gray italic">[]</span>;
    const allPrimitives = value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (allPrimitives) {
      return (
        <ul className="list-disc list-inside space-y-0.5">
          {value.map((v, i) => (
            <li key={i} className="text-xs text-text-primary"><JsonValue value={v} depth={depth + 1} /></li>
          ))}
        </ul>
      );
    }
    // Array of objects → mini-table over the union of keys.
    const allObjects = value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    if (allObjects) {
      const keys = Array.from(new Set(value.flatMap((row) => Object.keys(row as Record<string, unknown>))));
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border">
                {keys.map((k) => (
                  <th key={k} className="text-left py-1.5 px-2 text-text-secondary font-medium capitalize align-top">
                    {k.replace(/_/g, " ")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(value as Array<Record<string, unknown>>).map((row, i) => (
                <tr key={i} className="border-b border-border/30 align-top">
                  {keys.map((k) => (
                    <td key={k} className="py-1.5 px-2 text-text-primary text-xs max-w-[280px]">
                      <JsonValue value={row[k]} depth={depth + 1} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    // Mixed / nested arrays → indented list of JsonValue renders.
    return (
      <ol className="space-y-1 list-decimal list-inside">
        {value.map((v, i) => (
          <li key={i}><JsonValue value={v} depth={depth + 1} /></li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-text-gray italic">{"{}"}</span>;
    return (
      <dl className={`space-y-1 ${depth > 0 ? "pl-3 border-l border-border/40" : ""}`}>
        {entries.map(([k, v]) => (
          <div key={k} className="flex flex-col sm:flex-row sm:gap-2">
            <dt className="text-xs font-medium text-text-secondary capitalize sm:w-32 shrink-0">
              {k.replace(/_/g, " ")}
            </dt>
            <dd className="text-xs text-text-primary flex-1"><JsonValue value={v} depth={depth + 1} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="font-mono text-text-secondary">{String(value)}</span>;
}

function CopyJsonButton({ payload }: { payload: unknown }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard may be unavailable (insecure context). Silently no-op.
        }
      }}
      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:border-accent"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy JSON"}
    </button>
  );
}

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
  origin?: {
    connector_id?: string;
    event_kind?: string;
    execution_target?: string;
    trigger_id?: string;
    job_payload?: { job_id?: number; candidate_count?: number };
    execution_options?: {
      mode?: string;
      max_candidates?: number | null;
      push_to_odoo?: boolean;
      label_outputs?: boolean;
    } | null;
    triggered_by?: string | null;
  } | null;
  linkedin_applicants?: LinkedInApplicant[];
}

interface OutreachTarget {
  profile_url: string;
  name: string;
  headline?: string;
  score?: number | null;
  recommendation?: string | null;
  odoo_url?: string | null;
  rendered_message: string;
}

interface MessageTargetsResponse {
  targets: OutreachTarget[];
  template: string;
  count: number;
  skipped?: string;
}

interface LinkedInApplicant {
  id: number | null;
  name: string;
  profile_url?: string;
  job_id?: number | null;
  job_name?: string | null;
  status?: string;
  score?: number | null;
  score_int?: number | null;
  recommendation?: string | null;
  reasoning?: string | null;
  easy_recruit_status?: string | null;
  odoo_url?: string | null;
  refreshed_at?: string;
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
  const { request, postKeepalive } = useApi();

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
  const [activeTab, setActiveTab] = useState<"timeline" | "events" | "extraction" | "screenshots">("timeline");

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasShownIntervention = useRef<string | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);
  const activeStepRef = useRef<HTMLDivElement>(null);

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    try {
      const data = await request<RunDetail>("GET", `/runs/${runId}`);
      setRun(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run");
      return null;
    }
  }, [runId, request]);

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

  const [outreach, setOutreach] = useState<MessageTargetsResponse | null>(null);
  const [outreachLoading, setOutreachLoading] = useState(false);
  const fetchOutreach = useCallback(async () => {
    if (!runId) return;
    setOutreachLoading(true);
    try {
      const data = await request<MessageTargetsResponse>("GET", `/runs/${runId}/message-targets`);
      setOutreach(data);
    } catch (e) {
      console.error("fetch message-targets failed", e);
    } finally {
      setOutreachLoading(false);
    }
  }, [runId, request]);

  const [refreshingApplicants, setRefreshingApplicants] = useState(false);
  const refreshApplicants = useCallback(async () => {
    if (!runId) return;
    setRefreshingApplicants(true);
    try {
      await request<{ refreshed: number; applicants?: LinkedInApplicant[] }>(
        "POST",
        `/runs/${runId}/refresh-applicants`,
      );
      await fetchRun();
    } catch (e) {
      console.error("refresh applicants failed", e);
    } finally {
      setRefreshingApplicants(false);
    }
  }, [runId, request, fetchRun]);

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
    if (run?.origin?.event_kind === "new_job_position" && !outreach) {
      fetchOutreach();
    }
  }, [run?.origin?.event_kind, outreach, fetchOutreach]);

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

  // Closing this run-tracking window should SUSPEND a daemon-driven run (the
  // daemon runs in its own browser; this window is the only "is anyone watching?"
  // signal). On pagehide we POST /tab-closed (keepalive so it survives unload) →
  // backend moves the run to waiting_for_user(pause_reason="tab_closed") and the
  // daemon, which re-checks run.status between steps, stops. We use a ref so the
  // listener always sees the latest run, and ONLY pagehide (not visibilitychange,
  // which also fires on a mere tab switch — we must not suspend on that).
  // Autonomous runs (Odoo pipeline / webhook / reconciler) have no human watcher —
  // closing this window must NOT suspend them. Only INTERACTIVE daemon runs (no
  // autonomous event_kind) are watch-gated. The backend enforces this too; this
  // is the first line + avoids a wasteful POST. Keep in sync with
  // execution_service._AUTONOMOUS_EVENT_KINDS.
  const AUTONOMOUS_EVENT_KINDS = [
    "recruiter_create_project", "recruiter_search", "recruiter_save", "recruiter_message",
    "new_job_position", "linkedin_lead_search", "recruiter_pipeline",
  ];
  const liveRunRef = useRef<{ target?: string; status?: string; eventKind?: string } | null>(null);
  liveRunRef.current = run
    ? { target: run.origin?.execution_target, status: run.status, eventKind: run.origin?.event_kind }
    : null;
  useEffect(() => {
    if (!runId) return;
    const onHide = () => {
      const r = liveRunRef.current;
      if (!r || r.target !== "daemon") return;
      if (r.eventKind && AUTONOMOUS_EVENT_KINDS.includes(r.eventKind)) return;
      if (!["queued", "running", "recovering"].includes(r.status || "")) return;
      postKeepalive(`/runs/${runId}/tab-closed`);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [runId, postKeepalive]);

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
  const pushedApplicants = run.linkedin_applicants || [];
  const displayedApplicants = pushedApplicants;

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
            {run.origin?.execution_options?.mode === "test" && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-warning/15 text-warning border border-warning/30"
                title={`Test run · cap ${run.origin.execution_options.max_candidates ?? "∞"}${run.origin.execution_options.push_to_odoo === false ? " · no Odoo push" : ""}`}
              >
                Test
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            {workflow && <span className="font-mono text-text-gray">#{run.id.slice(0, 8)}</span>}
            <span>Step {run.current_step_index + 1} of {run.total_steps}</span>
            {run.origin?.triggered_by && <span>By {run.origin.triggered_by}</span>}
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
        {(["timeline", "events", "extraction", "screenshots"] as const).map((tab) => {
          const count = tab === "events" ? events.length : tab === "extraction" ? extractionEvents.length : tab === "screenshots" ? 0 : displaySteps.length;
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

      {run.origin?.event_kind === "new_job_position" && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-text-primary">LinkedIn Applicants Pushed to Odoo</h2>
              <p className="text-xs text-text-secondary mt-0.5">
                Job #{run.origin?.job_payload?.job_id ?? "—"} · {displayedApplicants.length} applicant{displayedApplicants.length === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              onClick={refreshApplicants}
              disabled={refreshingApplicants}
              className="text-xs px-2 py-1 rounded-md border border-border hover:bg-bg-elevated text-text-primary disabled:opacity-50 flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={refreshingApplicants ? "animate-spin" : ""} />
              {refreshingApplicants ? "Refreshing…" : "Refresh from Odoo"}
            </button>
          </div>
          {displayedApplicants.length === 0 ? (
            <div className="text-xs text-text-secondary py-4 text-center">
              No applicants pushed yet. Click <span className="text-text-primary">Refresh from Odoo</span> to backfill from a prior run.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-text-gray border-b border-border">
                    <th className="py-2 pr-3 font-medium">Name</th>
                    <th className="py-2 pr-3 font-medium">Score</th>
                    <th className="py-2 pr-3 font-medium">Recommendation</th>
                    <th className="py-2 pr-3 font-medium">Status</th>
                    <th className="py-2 pr-3 font-medium">Links</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedApplicants.map((a, idx) => {
                    const scoreNum = typeof a.score === "number" ? a.score : null;
                    const scoreColor =
                      scoreNum == null
                        ? "var(--color-text-gray)"
                        : scoreNum >= 8
                        ? "var(--color-success)"
                        : scoreNum >= 6
                        ? "var(--color-info)"
                        : scoreNum >= 4
                        ? "var(--color-warning)"
                        : "var(--color-error)";
                    return (
                      <tr key={`${a.id ?? "n"}-${idx}`} className="border-b border-border/40 last:border-b-0">
                        <td className="py-2 pr-3">
                          <div className="text-text-primary">{a.name || <span className="text-text-gray">(unnamed)</span>}</div>
                          {a.reasoning && (
                            <div className="text-[11px] text-text-gray line-clamp-2 max-w-[28rem]" title={a.reasoning}>
                              {a.reasoning}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          {scoreNum != null ? (
                            <span className="font-mono font-medium" style={{ color: scoreColor }}>
                              {scoreNum}/10
                            </span>
                          ) : (
                            <span className="text-text-gray text-xs">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-text-secondary text-xs">
                          {a.recommendation || "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs text-text-secondary">
                          {a.easy_recruit_status || a.status || "—"}
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          <div className="flex gap-2">
                            {a.profile_url && (
                              <a
                                href={a.profile_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-info hover:underline"
                              >
                                LinkedIn
                              </a>
                            )}
                            {a.odoo_url && (
                              <a
                                href={a.odoo_url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-accent hover:underline"
                              >
                                View in Odoo
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {run.origin?.event_kind === "new_job_position" && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-medium text-text-primary">Outreach Drafts</h2>
              <p className="text-xs text-text-secondary mt-0.5">
                Per-candidate LinkedIn Connect-with-note text rendered from the workflow's template
                {outreach?.count ? ` · ${outreach.count} draft${outreach.count === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={fetchOutreach}
              disabled={outreachLoading}
              className="text-xs px-2 py-1 rounded-md border border-border hover:bg-bg-elevated text-text-primary disabled:opacity-50 flex items-center gap-1.5"
            >
              <RefreshCw size={12} className={outreachLoading ? "animate-spin" : ""} />
              {outreachLoading ? "Loading…" : "Reload"}
            </button>
          </div>
          {outreach?.skipped === "no_template" ? (
            <div className="text-xs text-text-secondary py-4 text-center">
              This workflow has no message template configured.{" "}
              <a href={`/workflows/${run.workflow_id}`} className="text-info hover:underline">
                Configure template →
              </a>
            </div>
          ) : !outreach || outreach.targets.length === 0 ? (
            <div className="text-xs text-text-secondary py-4 text-center">
              {outreachLoading ? "Fetching drafts…" : "No drafts yet — drafts appear once profiles are extracted."}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {outreach.targets.map((t, idx) => {
                const tooLong = t.rendered_message.length > 300;
                return (
                  <div
                    key={`${t.profile_url}-${idx}`}
                    className="rounded-md border border-border bg-bg-elevated p-3"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div>
                        <div className="text-sm text-text-primary font-medium">{t.name || "(unnamed)"}</div>
                        {t.headline && (
                          <div className="text-[11px] text-text-gray line-clamp-1 max-w-[24rem]" title={t.headline}>
                            {t.headline}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        {typeof t.score === "number" && (
                          <span
                            className="text-[11px] font-mono"
                            style={{
                              color:
                                t.score >= 8 ? "var(--color-success)" :
                                t.score >= 6 ? "var(--color-info)" :
                                t.score >= 4 ? "var(--color-warning)" :
                                "var(--color-error)",
                            }}
                          >
                            {t.score}/10
                          </span>
                        )}
                        {t.recommendation && (
                          <span className="text-[11px] text-text-secondary">{t.recommendation}</span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-text-primary whitespace-pre-wrap mb-2 border border-border/60 rounded bg-bg p-2 font-mono">
                      {t.rendered_message || <span className="text-text-gray italic">(empty)</span>}
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span
                        className="font-mono"
                        style={{ color: tooLong ? "var(--color-error)" : "var(--color-text-gray)" }}
                        title="LinkedIn note limit is 300 chars; longer notes are truncated when pasted."
                      >
                        {t.rendered_message.length}/300 chars{tooLong ? " · truncated on paste" : ""}
                      </span>
                      <div className="flex gap-2">
                        {t.profile_url && (
                          <a href={t.profile_url} target="_blank" rel="noreferrer" className="text-info hover:underline">
                            LinkedIn
                          </a>
                        )}
                        {t.odoo_url && (
                          <a href={t.odoo_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                            Odoo
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Step Timeline */}
      {activeTab === "timeline" && runId && <FlowManifest runId={runId} />}
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
            <div className="space-y-6">
              {extractionEvents.map((event) => {
                const records = (event.payload.data as unknown[]) || [];
                if (records.length === 0) return null;
                const stepIndex = event.payload.step_index as number;
                return (
                  <section key={event.id} className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs text-text-secondary">
                        Step {stepIndex + 1} — {records.length} record{records.length === 1 ? "" : "s"}
                      </h3>
                      <CopyJsonButton payload={records} />
                    </div>
                    <div className="space-y-4">
                      {records.map((record, ri) => (
                        <div key={ri} className="rounded-lg border border-border bg-bg-elevated p-3">
                          <JsonValue value={record} />
                        </div>
                      ))}
                    </div>
                    <details className="rounded border border-border bg-bg-card">
                      <summary className="cursor-pointer px-3 py-2 text-xs text-text-secondary hover:text-text-primary">
                        Raw JSON
                      </summary>
                      <pre className="overflow-x-auto px-3 py-2 text-xs font-mono text-text-primary whitespace-pre-wrap break-words">
                        {JSON.stringify(records, null, 2)}
                      </pre>
                    </details>
                  </section>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* Per-step screenshots (page captures uploaded by the daemon) */}
      {activeTab === "screenshots" && (
        <Card>
          {runId && <StepScreenshots runId={runId} />}
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
