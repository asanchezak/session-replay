import { Circle, CircleDot, Play, AlertTriangle, RefreshCw, Check, X, Minus } from "lucide-react";

type RunStatus =
  | "idle" | "recording" | "validated" | "queued" | "running"
  | "waiting_for_user" | "recovering" | "failed" | "completed" | "canceled";

type WorkflowStatus = "draft" | "active" | "archived";

interface StatusBadgeProps {
  status: RunStatus | WorkflowStatus;
  size?: "sm" | "md";
}

const runConfig: Record<RunStatus, { color: string; label: string; icon: typeof Circle }> = {
  idle: { color: "#6B7280", label: "Idle", icon: Circle },
  recording: { color: "#E17055", label: "Recording", icon: CircleDot },
  validated: { color: "#6B7280", label: "Validated", icon: Circle },
  queued: { color: "#74B9FF", label: "Queued", icon: Circle },
  running: { color: "#74B9FF", label: "Running", icon: Play },
  waiting_for_user: { color: "#FDCB6E", label: "Waiting", icon: AlertTriangle },
  recovering: { color: "#FDCB6E", label: "Recovering", icon: RefreshCw },
  failed: { color: "#E17055", label: "Failed", icon: X },
  completed: { color: "#00B894", label: "Completed", icon: Check },
  canceled: { color: "#6B7280", label: "Canceled", icon: Minus },
};

const workflowConfig: Record<WorkflowStatus, { color: string; label: string }> = {
  draft: { color: "#6B7280", label: "Draft" },
  active: { color: "#00B894", label: "Active" },
  archived: { color: "#6B7280", label: "Archived" },
};

export default function StatusBadge({ status, size = "md" }: StatusBadgeProps) {
  const fontSize = size === "sm" ? "11px" : "12px";
  const iconSize = size === "sm" ? 10 : 12;

  if (status in runConfig) {
    const cfg = runConfig[status as RunStatus];
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

  const cfg = workflowConfig[status as WorkflowStatus];
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
