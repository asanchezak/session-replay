type RunEvent = {
  event_type: string;
  payload: Record<string, unknown>;
};

export function getStepStatus(
  stepIdx: number,
  currentIdx: number,
  runStatus: string,
  events: RunEvent[],
): string {
  if (["completed"].includes(runStatus) && stepIdx < currentIdx) return "completed";
  if (["failed", "canceled"].includes(runStatus) && stepIdx < currentIdx) return "completed";

  const stepEvents = events.filter(
    (event) => event.event_type === "step_executed" && (event.payload as { step_index?: number })?.step_index === stepIdx,
  );
  if (stepEvents.length > 0) {
    const last = stepEvents[stepEvents.length - 1];
    if ((last.payload as { success?: boolean })?.success === true) return "completed";
    if ((last.payload as { success?: boolean })?.success === false) return "failed";
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

export function formatDuration(start?: string, end?: string): string | null {
  if (!start) return null;
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export function truncatePayload(payload: Record<string, unknown>, maxLen = 80): string {
  const raw = JSON.stringify(payload);
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}...`;
}

export function formatEventSummary(event: RunEvent): string {
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
