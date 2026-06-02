import { Cpu, Workflow } from "lucide-react";

interface ExecutionModeBadgeProps {
  mode?: string;
  size?: "sm" | "md";
}

/**
 * Pill showing how the daemon runs a workflow:
 *  - "hardcoded" → a bespoke daemon flow (the lead/applicant preamble)
 *  - "generic"   → the plan-interpreter drives the recorded steps
 * Unknown/missing mode renders nothing.
 */
export default function ExecutionModeBadge({ mode, size = "sm" }: ExecutionModeBadgeProps) {
  if (mode !== "hardcoded" && mode !== "generic") return null;
  const isGeneric = mode === "generic";
  const Icon = isGeneric ? Workflow : Cpu;
  const text = size === "sm" ? "text-[11px]" : "text-xs";
  const tone = isGeneric
    ? "border-accent/30 bg-accent/10 text-accent"
    : "border-warning/30 bg-warning/10 text-warning";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${text} ${tone}`}
      title={
        isGeneric
          ? "Generic — the daemon interprets the recorded plan"
          : "Hardcoded — a bespoke daemon flow"
      }
    >
      <Icon size={size === "sm" ? 11 : 12} />
      {isGeneric ? "Generic" : "Hardcoded"}
    </span>
  );
}
