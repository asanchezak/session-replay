import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";

export default function Breadcrumbs() {
  const location = useLocation();
  const { request } = useApi();
  const [workflowName, setWorkflowName] = useState<string | null>(null);

  const segments = location.pathname.split("/").filter(Boolean);

  useEffect(() => {
    const match = location.pathname.match(/^\/workflows\/([^/]+)$/);
    if (match) {
      request<{ id: string; name: string }>("GET", `/workflows/${match[1]}`)
        .then((w) => setWorkflowName(w.name))
        .catch(() => setWorkflowName(null));
    } else {
      setWorkflowName(null);
    }
  }, [location.pathname, request]);

  const crumbs: { label: string; href?: string }[] = [];

  if (segments[0] === "workflows") {
    crumbs.push({ label: "Workflows", href: "/workflows" });
    if (segments[1]) {
      crumbs.push({ label: workflowName || segments[1].slice(0, 8) });
    }
  } else if (segments[0] === "positions") {
    crumbs.push({ label: "Positions", href: "/positions" });
    if (segments[1]) {
      crumbs.push({ label: `Job ${segments[1]}` });
    }
  } else if (segments[0] === "runs") {
    crumbs.push({ label: "Runs", href: "/runs" });
    if (segments[1]) {
      crumbs.push({ label: `Run #${segments[1].slice(0, 8)}` });
    }
  } else if (segments[0] === "audit") {
    crumbs.push({ label: "Audit" });
  } else if (segments[0] === "settings") {
    crumbs.push({ label: "Settings" });
  }

  return (
    <nav className="flex items-center gap-2 text-xs text-[#6B7280] mb-4" aria-label="Breadcrumb">
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-[#2D3148]">/</span>}
          {crumb.href ? (
            <Link to={crumb.href} className="hover:text-[#9AA0B0] transition-colors">
              {crumb.label}
            </Link>
          ) : (
            <span className="text-[#9AA0B0]">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
