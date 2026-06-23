import { useEffect, useState, useCallback, useRef } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { LayoutDashboard, GitBranch, Play, ScrollText, Cable, Settings, Search, X } from "lucide-react";
import ErrorBoundary from "./components/ErrorBoundary";
import InterventionModal from "./components/InterventionModal";
import Breadcrumbs from "./components/Breadcrumbs";
import DaemonStatusPill from "./components/DaemonStatusPill";
import { useApi } from "./hooks/useApi";
import { logger } from "./lib/logger";

interface SearchResult {
  id: string;
  label: string;
  type: "workflow" | "run";
  path: string;
}

// Which environment is this dashboard pointing at? Explicit VITE_ENV_LABEL (baked per
// build: DEV / PROD) wins; otherwise infer from the host it's served on. PROD shows red
// (caution — live LinkedIn account + real Odoo), DEV blue, anything else gray.
function resolveEnv(): { label: string; cls: string } {
  let label = ((import.meta.env.VITE_ENV_LABEL as string | undefined) || "").toUpperCase();
  if (!label) {
    const h = window.location.hostname;
    if (h.includes("54-211-23-18")) label = "PROD";
    else if (h.includes("52-5-45-84")) label = "DEV";
    else label = "LOCAL";
  }
  const isProd = label === "PROD" || label === "PRODUCTION";
  const cls = isProd
    ? "bg-[#E74C3C] text-white"
    : label === "DEV"
      ? "bg-[#3B82F6] text-white"
      : "bg-[#6B7280] text-white";
  return { label, cls };
}

const ENV = resolveEnv();

export default function AppShell() {
  const [waitingRun, setWaitingRun] = useState<{
    id: string;
    workflow_id: string;
    workflow_name?: string;
    current_step_index: number;
    total_steps: number;
    pause_reason?: string;
    error_summary?: string;
  } | null>(null);
  const { request } = useApi();
  const navigate = useNavigate();
  const location = window.location;

  // Prefix the browser tab title with the env so DEV/PROD tabs are distinguishable.
  useEffect(() => {
    document.title = `[${ENV.label}] Session Replay`;
  }, []);

  const checkWaitingRuns = useCallback(async () => {
    try {
      const runs = await request<any[]>("GET", "/runs?status=waiting_for_user&limit=1");
      if (runs && runs.length > 0) {
        const r = runs[0];
        let workflowName: string | undefined;
        try {
          const wf = await request<any>("GET", `/workflows/${r.workflow_id}`);
          workflowName = wf.name;
        } catch {}
        setWaitingRun({
          id: r.id,
          workflow_id: r.workflow_id,
          workflow_name: workflowName,
          current_step_index: r.current_step_index,
          total_steps: r.total_steps,
          pause_reason: r.pause_reason,
          error_summary: r.error_summary,
        });
        logger.warn("AppShell", "intervention_modal_shown", {
          run_id: r.id,
          workflow_id: r.workflow_id,
          step: r.current_step_index,
          reason: r.pause_reason,
        });
      } else {
        setWaitingRun(null);
      }
    } catch {
      // silent
    }
  }, [request]);

  useEffect(() => {
    checkWaitingRuns();
    const interval = setInterval(checkWaitingRuns, 5000);
    return () => clearInterval(interval);
  }, [checkWaitingRuns]);

  const dismissedRef = useRef<string | null>(null);
  const onCurrentRunPage = waitingRun && location.pathname === `/runs/${waitingRun.id}`;
  const isDismissed = waitingRun && dismissedRef.current === waitingRun.id;

  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <TopBar waitingRun={!!waitingRun && !isDismissed} />
        <main className="flex-1 p-6 overflow-auto" role="main">
          <Breadcrumbs />
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      {waitingRun && !onCurrentRunPage && !isDismissed && (
        <InterventionModal
          runId={waitingRun.id}
          runName={waitingRun.workflow_name || `Workflow ${waitingRun.workflow_id.slice(0, 8)}`}
          blockedStep={waitingRun.current_step_index + 1}
          blockedStepName={waitingRun.error_summary || waitingRun.pause_reason || "Unknown step"}
          explanation={waitingRun.error_summary || waitingRun.pause_reason || "The system encountered a condition that requires your input."}
          instructions={[
            "Review the current browser state.",
            "Complete any required action (e.g., CAPTCHA, form input).",
            "Click \"Continue Workflow\" to resume from where it paused.",
          ]}
          onClose={() => { dismissedRef.current = waitingRun.id; setWaitingRun(null); }}
          onReview={() => {
            navigate(`/runs/${waitingRun.id}`);
            dismissedRef.current = null;
            setWaitingRun(null);
          }}
          onResolved={() => { logger.info("AppShell", "intervention_modal_resolved", { run_id: waitingRun?.id }); dismissedRef.current = null; setWaitingRun(null); checkWaitingRuns(); }}
        />
      )}
    </div>
  );
}

const navItems = [
  { label: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
  { label: "Workflows", path: "/workflows", icon: GitBranch },
  { label: "Runs", path: "/runs", icon: Play },
  { label: "Audit", path: "/audit", icon: ScrollText },
  { label: "Connectors", path: "/connectors", icon: Cable },
  { label: "Settings", path: "/settings", icon: Settings },
];

function Sidebar() {
  const { request } = useApi();
  const [runsCount, setRunsCount] = useState(0);

  const fetchCounts = async () => {
    try {
      const runs = await request<any[]>("GET", "/runs?limit=100");
      const active = runs.filter(
        (r: any) => r.status === "running" || r.status === "waiting_for_user"
      );
      setRunsCount(active.length);
    } catch {
    }
  };

  useEffect(() => {
    fetchCounts();
    const interval = setInterval(fetchCounts, 30000);
    const handler = () => { fetchCounts(); };
    window.addEventListener("runs:updated", handler);
    return () => {
      clearInterval(interval);
      window.removeEventListener("runs:updated", handler);
    };
  }, [request]);

  return (
    <nav className="w-56 bg-[#1A1D27] border-r border-[#2D3148] flex flex-col p-4 gap-1" role="navigation" aria-label="Main navigation">
      <div className="mb-6 px-3">
        <div className="text-[#E8EAED] font-semibold text-base">Session Replay</div>
        <span
          className={`inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wider rounded px-1.5 py-0.5 leading-none ${ENV.cls}`}
          title={`Environment: ${ENV.label}`}
        >
          {ENV.label}
        </span>
      </div>
      {navItems.map((item) => {
        const Icon = item.icon;
        const showBadge = item.path === "/runs" && runsCount > 0;
        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                isActive
                  ? "bg-[#242836] text-[#E8EAED]"
                  : "text-[#9AA0B0] hover:text-[#E8EAED] hover:bg-[#242836]"
              }`
            }
          >
            <Icon size={16} />
            <span className="flex-1">{item.label}</span>
            {showBadge && (
              <span className="text-[11px] bg-[#6C5CE7] text-white rounded-full px-1.5 py-0.5 font-medium leading-none">
                {runsCount}
              </span>
            )}
          </NavLink>
        );
      })}
    </nav>
  );
}

function TopBar({ waitingRun }: { waitingRun: boolean }) {
  const navigate = useNavigate();
  const { request } = useApi();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const [workflows, runs] = await Promise.all([
          request<any[]>("GET", "/workflows"),
          request<any[]>("GET", "/runs?limit=100"),
        ]);
        if (cancelled) return;
        const q = query.toLowerCase();
        const filtered: SearchResult[] = [
          ...workflows
            .filter((w: any) => w.name?.toLowerCase().includes(q) || w.description?.toLowerCase().includes(q))
            .map((w: any) => ({ id: w.id, label: w.name, type: "workflow" as const, path: `/workflows/${w.id}` })),
          ...runs
            .filter((r: any) => r.id?.toLowerCase().includes(q) || r.status?.toLowerCase().includes(q))
            .map((r: any) => ({ id: r.id, label: `Run #${r.id.slice(0, 8)}`, type: "run" as const, path: `/runs/${r.id}` })),
        ];
        setResults(filtered);
      } catch {
        if (!cancelled) setResults([]);
      }
      if (!cancelled) setLoading(false);
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, request]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        setShowResults(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleSelect = (result: SearchResult) => {
    navigate(result.path);
    setQuery("");
    setShowResults(false);
    inputRef.current?.blur();
  };

  return (
    <header className="h-12 border-b border-[#2D3148] flex items-center px-6 gap-4">
      <div className="flex items-center gap-3 flex-1">
        <div className="relative w-full max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6B7280]" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search workflows, runs, logs..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowResults(true); }}
            onFocus={() => { if (query.trim()) setShowResults(true); }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setShowResults(false); inputRef.current?.blur(); }
            }}
            className="w-full bg-[#2A2E3D] text-[#E8EAED] text-sm rounded-md pl-9 pr-9 py-1.5 border border-[#2D3148] placeholder:text-[#6B7280] focus:outline-none focus:border-[#6C5CE7] transition-colors"
            aria-label="Search"
            role="searchbox"
          />
          {query && (
            <button
              onClick={() => { setQuery(""); setResults([]); setShowResults(false); inputRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-[#E8EAED] transition-colors"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
          {showResults && query.trim() && (
            <div
              ref={dropdownRef}
              className="absolute top-full left-0 right-0 mt-1 bg-[#1A1D27] border border-[#2D3148] rounded-md shadow-lg max-h-64 overflow-auto z-50"
              role="listbox"
            >
              {loading ? (
                <div className="p-3 text-[#6B7280] text-sm">Searching...</div>
              ) : results.length === 0 ? (
                <div className="p-3 text-[#6B7280] text-sm">No results found</div>
              ) : (
                results.map((r) => (
                  <button
                    key={`${r.type}-${r.id}`}
                    onClick={() => handleSelect(r)}
                    className="w-full flex items-center gap-3 px-3 py-2 text-sm text-[#E8EAED] hover:bg-[#242836] transition-colors text-left"
                    role="option"
                  >
                    <span className={`text-xs font-medium uppercase ${r.type === "workflow" ? "text-[#74B9FF]" : "text-[#00B894]"}`}>
                      {r.type}
                    </span>
                    <span className="truncate">{r.label}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <div
        className="flex items-center gap-2 text-xs"
        aria-label={waitingRun ? "Attention required" : "System status: All systems healthy"}
      >
        <span className={`w-2 h-2 rounded-full ${waitingRun ? "bg-[#FDCB6E] animate-pulse" : "bg-[#00B894]"}`} />
        <span className="text-[#9AA0B0]">{waitingRun ? "Needs Attention" : "All Systems"}</span>
      </div>
      <DaemonStatusPill />
      <a
        href="http://localhost:8082"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 text-xs text-[#6B7280] hover:text-[#6C5CE7] transition-colors ml-3"
        title="Open centralized logs (Seq)"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
          <polyline points="10 9 9 9 8 9" />
        </svg>
        Logs
      </a>
    </header>
  );
}
