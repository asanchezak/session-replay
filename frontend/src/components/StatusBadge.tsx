import { Circle, CircleDot, Play, AlertTriangle, RefreshCw, Check, X, Minus } from "lucide-react";

type RunStatus =
  | "idle" | "recording" | "validated" | "queued" | "running"
  | "waiting_for_user" | "recovering" | "failed" | "completed" | "canceled";

type WorkflowStatus = "active" | "archived";

interface StatusBadgeProps {
  status: RunStatus | WorkflowStatus | string;
  size?: "sm" | "md";
}

const runConfig: Record<RunStatus, { color: string; label: string; icon: typeof Circle }> = {
  idle: { color: "var(--color-text-gray)", label: "Idle", icon: Circle },
  recording: { color: "var(--color-error)", label: "Recording", icon: CircleDot },
  validated: { color: "var(--color-text-gray)", label: "Validated", icon: Circle },
  queued: { color: "var(--color-info)", label: "Queued", icon: Circle },
  running: { color: "var(--color-info)", label: "Running", icon: Play },
  waiting_for_user: { color: "var(--color-warning)", label: "Waiting", icon: AlertTriangle },
  recovering: { color: "var(--color-warning)", label: "Recovering", icon: RefreshCw },
  failed: { color: "var(--color-error)", label: "Failed", icon: X },
  completed: { color: "var(--color-success)", label: "Completed", icon: Check },
  canceled: { color: "var(--color-text-gray)", label: "Canceled", icon: Minus },
};

const workflowConfig: Record<WorkflowStatus, { color: string; label: string }> = {
  active: { color: "var(--color-success)", label: "Active" },
  archived: { color: "var(--color-text-gray)", label: "Archived" },
};

// Short aliases produced by RunDetailPage's getStepStatus()
const stepStatusAlias: Record<string, RunStatus> = {
  waiting: "waiting_for_user",
  pending: "queued",
};

const fallbackConfig = { color: "var(--color-text-gray)", label: "Unknown", icon: Circle };

export default function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  const fontSize = size === "sm" ? "11px" : "12px";
  const iconSize = size === "sm" ? 10 : 12;

  const resolvedRunStatus = (stepStatusAlias[status as string] || status) as RunStatus;

  if (resolvedRunStatus in runConfig) {
    const cfg = runConfig[resolvedRunStatus];
    const Icon = cfg.icon;
    return (
      <span
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize, color: cfg.color, fontWeight: 500 }}
        aria-label={`Status: ${cfg.label}`}
      >
        <Icon size={iconSize} />
        {cfg.label}
      </span>
    );
  }

  const cfg = workflowConfig[status as WorkflowStatus] || fallbackConfig;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize, color: cfg.color, fontWeight: 500 }}
      aria-label={`Status: ${cfg.label}`}
    >
      <span style={{ width: iconSize, height: iconSize, borderRadius: "50%", background: cfg.color }} />
      {cfg.label}
    </span>
  );
}
