import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import Banner from "../components/Banner";
import { useApi, useApiData } from "../hooks/useApi";
import { formatTime, formatTimeShort } from "../lib/formatTime";
import { ArrowLeft, Pause, Play, RotateCcw, Square, ChevronDown, ChevronRight, CheckCircle, AlertTriangle } from "lucide-react";

interface StepInfo {
  action_type: string;
  intent?: string;
  selector_chain?: Array<{ type: string; value: string }>;
  value?: string;
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

const eventColors: Record<string, string> = {
  run_started: "var(--color-info)",
  run_paused: "var(--color-warning)",
  run_resumed: "var(--color-success)",
  run_completed: "var(--color-success)",
  run_failed: "var(--color-error)",
  run_canceled: "var(--color-text-gray)",
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
};

const eventIcons: Record<string, typeof CheckCircle> = {
  run_started: Play,
  run_paused: Pause,
  run_resumed: Play,
  run_completed: CheckCircle,
  run_failed: AlertTriangle,
  checkpoint: CheckCircle,
  recovery_attempt: RotateCcw,
  recovery_success: CheckCircle,
  recovery_failure: AlertTriangle,
};

function truncatePayload(payload: Record<string, unknown>, maxLen = 80): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= maxLen) return raw;
  return raw.slice(0, maxLen) + "...";
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { request } = useApi();

  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [showRecovery, setShowRecovery] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const data = await request<RunEvent[]>("GET", `/runs/${runId}/events`);
      setEvents(data);
    } catch {
    }
  }, [runId, request]);

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    Promise.all([fetchRun(), fetchEvents()]).finally(() => setLoading(false));

    pollingRef.current = setInterval(() => {
      fetchEvents();
    }, 3000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [runId]);

  const handleAction = async (action: string, endpoint: string) => {
    setActionLoading(action);
    setError(null);
    try {
      await request("POST", endpoint);
      await fetchRun();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`);
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

  if (loading && !run) {
    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-4 bg-bg-elevated rounded animate-pulse" />
          <div className="w-40 h-6 bg-bg-elevated rounded animate-pulse" />
        </div>
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
      </div>
    );
  }

  if (error && !run) {
    return (
      <div>
        <button
          onClick={() => navigate("/runs")}
          className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors"
        >
          <ArrowLeft size={14} /> Back to Runs
        </button>
        <Banner type="error" title="Error loading run" action={
          <button
            onClick={() => { setError(null); setLoading(true); Promise.all([fetchRun(), fetchEvents()]).finally(() => setLoading(false)); }}
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
  const isRecovering = run.status === "recovering";
  const isTerminal = ["completed", "failed", "canceled"].includes(run.status);

  const progressPct = run.total_steps > 0 ? Math.round((run.current_step_index / run.total_steps) * 100) : 0;

  const recoveryEvents = events.filter(
    (e) => e.event_type === "recovery_attempt" || e.event_type === "recovery_success" || e.event_type === "recovery_failure"
  );
  const hasRecovery = recoveryEvents.length > 0;

  const lastCheckpoint = [...events].reverse().find((e) => e.event_type === "checkpoint");

  return (
    <div>
      <button
        onClick={() => navigate("/runs")}
        className="flex items-center gap-1 text-text-secondary text-sm mb-4 hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={14} /> Back to Runs
      </button>

      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-semibold text-text-primary">
              Run <span className="font-mono">#{run.id.slice(0, 8)}</span>
            </h1>
            <StatusBadge status={run.status as any} size="sm" />
          </div>
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <span>Workflow: {run.workflow_id.slice(0, 8)}</span>
            {run.started_at && <span>Started: {formatTime(run.started_at)}</span>}
            {run.ended_at && <span>Ended: {formatTime(run.ended_at)}</span>}
            <span>Created: {formatTime(run.created_at)}</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <Banner type="error" title="Action failed">
            {error}
          </Banner>
        </div>
      )}

      <Card className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-text-secondary">
            Step {run.current_step_index} of {run.total_steps}
          </span>
          <span className="text-xs text-text-gray">{progressPct}%</span>
        </div>
        <div className="w-full h-2 bg-bg-elevated rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progressPct}%`,
              background: isTerminal && run.status === "failed" ? "var(--color-error)" : isTerminal ? "var(--color-success)" : "var(--color-accent)",
            }}
          />
        </div>
        <div className="flex items-center justify-between mt-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-info uppercase font-medium">
              {run.status}
            </span>
            <span className="text-sm text-text-primary">
              Step {run.current_step_index + 1}
            </span>
          </div>
          {isPaused && run.pause_reason && (
            <span className="text-xs text-warning">{run.pause_reason}</span>
          )}
        </div>
      </Card>

      {lastCheckpoint && (
        <Card className="mb-6" padding="sm">
          <div className="flex items-center gap-2 text-xs">
            <CheckCircle size={14} color="var(--color-success)" />
            <span className="text-success font-medium">Checkpoint reached</span>
            <span className="text-text-secondary">
              at step {(lastCheckpoint.payload as any)?.step_index ?? "—"} · {formatTimeShort(lastCheckpoint.created_at)}
            </span>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-2 mb-6 flex-wrap">
        {(isRunning || isPaused || isRecovering) && (
          <>
            {isRunning && (
              <button
                onClick={() => handleAction("pause", `/runs/${runId}/pause`)}
                disabled={actionLoading !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors disabled:opacity-50"
              >
                <Pause size={14} /> {actionLoading === "pause" ? "..." : "Pause"}
              </button>
            )}
            {isPaused && (
              <button
                onClick={() => handleAction("resume", `/runs/${runId}/resume`)}
                disabled={actionLoading !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
              >
                <Play size={14} /> {actionLoading === "resume" ? "..." : "Resume"}
              </button>
            )}
            <button
              onClick={() => handleAction("stop", `/runs/${runId}/cancel`)}
              disabled={actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border text-text-gray hover:text-error hover:border-error transition-colors disabled:opacity-50"
            >
              <Square size={14} /> {actionLoading === "stop" ? "..." : "Stop"}
            </button>
          </>
        )}
      </div>

      {hasRecovery && (
        <Card className="mb-6">
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
              const EventIcon = eventIcons[event.event_type];
              return (
                <div key={event.id}>
                  <button
                    onClick={() => toggleEventExpand(event.id)}
                    className="w-full flex items-center gap-3 py-2 px-3 rounded-md text-sm hover:bg-bg-elevated transition-colors text-left"
                  >
                    <span className="text-text-gray text-xs flex-shrink-0 w-14">{formatTimeShort(event.created_at)}</span>
                    <span
                      className="text-xs font-medium uppercase flex-shrink-0 w-24 truncate"
                      style={{ color: eventColors[event.event_type] || "var(--color-text-primary)" }}
                    >
                      {EventIcon && <EventIcon size={10} className="inline mr-1" style={{ color: eventColors[event.event_type] || "var(--color-text-primary)" }} />}
                      {event.event_type}
                    </span>
                    <span className="text-text-gray text-xs flex-shrink-0 w-14">{event.actor_type}</span>
                    <span className="text-text-secondary text-xs font-mono truncate flex-1">
                      {truncatePayload(event.payload)}
                    </span>
                    {event.payload && Object.keys(event.payload).length > 0 && (
                      <span className="text-text-gray text-xs flex-shrink-0">{isExpanded ? "▲" : "▼"}</span>
                    )}
                  </button>
                  {isExpanded && event.payload && Object.keys(event.payload).length > 0 && (
                    <div className="ml-[184px] mr-3 mb-2 p-3 bg-bg-elevated rounded-md">
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
    </div>
  );
}
