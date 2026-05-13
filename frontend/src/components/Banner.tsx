import { AlertTriangle, CheckCircle, XCircle, Info } from "lucide-react";
import type { ReactNode } from "react";

interface BannerProps {
  type: "warning" | "error" | "success" | "info";
  title: string;
  children: ReactNode;
  action?: ReactNode;
}

const config = {
  warning: { bg: "rgba(253,203,110,0.15)", border: "rgba(253,203,110,0.3)", color: "var(--color-warning)", icon: AlertTriangle },
  error: { bg: "rgba(225,112,85,0.15)", border: "rgba(225,112,85,0.3)", color: "var(--color-error)", icon: XCircle },
  success: { bg: "rgba(0,184,148,0.15)", border: "rgba(0,184,148,0.3)", color: "var(--color-success)", icon: CheckCircle },
  info: { bg: "rgba(116,185,255,0.15)", border: "rgba(116,185,255,0.3)", color: "var(--color-info)", icon: Info },
};

export default function Banner({ type, title, children, action }: BannerProps) {
  const cfg = config[type];
  const Icon = cfg.icon;

  return (
    <div style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon size={16} color={cfg.color} />
        <span style={{ fontWeight: 500, color: cfg.color, fontSize: 13 }}>{title}</span>
      </div>
      <div style={{ color: "var(--color-text-primary)", fontSize: 12 }}>{children}</div>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}
