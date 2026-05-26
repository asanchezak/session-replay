import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PopupState } from "../src/shared/types";
import { DASHBOARD_ORIGIN } from "../src/shared/constants";
import { createLogger } from "../src/shared/logger";

// ── Helpers ──────────────────────────────────────────────────────────────────

function openDashboard(path = "/dashboard") {
  chrome.tabs.create({ url: `${DASHBOARD_ORIGIN}${path}` });
}

function send(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg);
}

const log = createLogger("side-panel");

function sendRuntimeMessageWithTimeout<T>(message: Record<string, unknown>, timeoutMs = 45_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const startedAt = Date.now();
    const timeoutId = window.setTimeout(() => {
      log.warn("Runtime message timed out", {
        type: String(message.type || "unknown"),
        timeout_ms: timeoutMs,
        elapsed_ms: Date.now() - startedAt,
      });
      reject(new Error("Page analysis took too long. Try again after the page finishes loading."));
    }, timeoutMs);

    chrome.runtime.sendMessage(message, (response) => {
      window.clearTimeout(timeoutId);
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        log.error("Runtime message failed", {
          type: String(message.type || "unknown"),
          elapsed_ms: Date.now() - startedAt,
          error: runtimeError.message,
        });
        reject(new Error(runtimeError.message));
        return;
      }
      log.log("Runtime message completed", {
        type: String(message.type || "unknown"),
        elapsed_ms: Date.now() - startedAt,
      });
      resolve(response as T);
    });
  });
}

// ── Shared primitives ────────────────────────────────────────────────────────

const colors = {
  bg: "#0F1117",
  surface: "#1A1D27",
  border: "#2D3148",
  text: "#E8EAED",
  muted: "#9AA0B0",
  accent: "#6C5CE7",
  blue: "#74B9FF",
  red: "#E17055",
  yellow: "#FDCB6E",
  green: "#00B894",
};

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  width: "100%", padding: "10px 14px", borderRadius: "7px",
  border: "none", background: colors.accent, color: "#fff",
  fontSize: "13px", fontWeight: 500, cursor: "pointer", ...extra,
});

const ghostBtn = (color = colors.muted): React.CSSProperties => ({
  ...btn({ background: "transparent", border: `1px solid ${colors.border}`, color }),
});

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span style={{
      display: "inline-block", width: 8, height: 8, borderRadius: "50%",
      background: color, flexShrink: 0,
      animation: pulse ? "sr-panel-pulse 1.4s ease-in-out infinite" : "none",
    }} />
  );
}

function ProgressBar({ pct, color = colors.accent }: { pct: number; color?: string }) {
  return (
    <div style={{ height: 4, background: "#2A2E3D", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width 0.3s ease" }} />
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      border: `1px solid ${colors.border}`, borderRadius: "8px",
      padding: "12px", background: colors.surface, marginBottom: "10px",
    }}>
      {children}
    </div>
  );
}

// ── State-specific views ─────────────────────────────────────────────────────

function IdleView() {
  return (
    <>
      <style>{`@keyframes sr-panel-pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <button style={btn({ background: colors.red })}
          onClick={() => send({ type: "START_RECORDING" })}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
            <Dot color="#fff" /> Record Workflow
          </span>
        </button>
        <button style={btn()} onClick={() => openDashboard("/workflows")}>
          ▶ Run Workflow
        </button>
        <button style={ghostBtn(colors.blue)} onClick={() => openDashboard()}>
          <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Open Dashboard
          </span>
        </button>
        <div style={{ padding: "10px", borderRadius: "6px", background: colors.surface, textAlign: "center", color: colors.muted, fontSize: "12px" }}>
          No active workflow. Record or run one to start.
        </div>
      </div>
    </>
  );
}

type SuggestedField = {
  key: string;
  label: string;
  description?: string;
  shape?: { kind: "scalar" | "string_list" | "record_list" | "unknown"; item_keys: string[] | null };
};

type AnalyzeState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "suggested"; result: { page_url: string; page_title?: string; visible_text: string; dom_snippet: string; page_snapshots: Array<{ section_name: string; page_url: string; page_title?: string; visible_text: string; dom_snippet: string; captured_at: string }>; suggested_fields: SuggestedField[] } }
  | { type: "error"; code: string; message: string }
  | { type: "applied"; count: number };

function ShapeBadge({ kind }: { kind?: string }) {
  if (kind === "record_list") {
    return (
      <span style={{
        background: `${colors.accent}33`, color: colors.accent,
        fontSize: 9, fontWeight: 600, padding: "1px 6px",
        borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.5,
      }}>multiple</span>
    );
  }
  if (kind === "string_list") {
    return (
      <span style={{
        background: "#2A2E3D", color: colors.muted,
        fontSize: 9, fontWeight: 600, padding: "1px 6px",
        borderRadius: 3, textTransform: "uppercase", letterSpacing: 0.5,
      }}>list</span>
    );
  }
  return null;
}

function AnalyzePageSection() {
  const [analyze, setAnalyze] = useState<AnalyzeState>({ type: "idle" });
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);

  const handleAnalyze = async () => {
    setAnalyze({ type: "loading" });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      log.log("Analyze requested", {
        tab_id: tab?.id ?? null,
        tab_url: tab?.url ?? null,
      });
      const response = await sendRuntimeMessageWithTimeout<{
        type: string;
        analysis?: AnalyzeState extends infer A ? A extends { result: infer R } ? R : never : never;
        error?: string;
        code?: string;
      }>({
        type: "ANALYZE_LIVE_PAGE",
        tabId: tab?.id,
      });
      if (response?.type === "ANALYZE_LIVE_PAGE_RESULT" && response.analysis) {
        log.log("Analyze succeeded", {
          suggested_field_count: response.analysis.suggested_fields.length,
          page_snapshot_count: response.analysis.page_snapshots.length,
          visible_text_length: response.analysis.visible_text.length,
          dom_snippet_length: response.analysis.dom_snippet.length,
        });
        setAnalyze({ type: "suggested", result: response.analysis });
        setSelectedKeys(response.analysis.suggested_fields.map((f) => f.key));
      } else {
        log.warn("Analyze failed response", {
          code: response?.code || "ANALYSIS_FAILED",
          error: response?.error || "Page analysis failed.",
        });
        setAnalyze({
          type: "error",
          code: response?.code || "ANALYSIS_FAILED",
          message: response?.error || "Page analysis failed.",
        });
      }
    } catch (err) {
      log.error("Analyze threw", err instanceof Error ? err.message : String(err));
      setAnalyze({ type: "error", code: "ANALYSIS_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleApply = async () => {
    if (analyze.type !== "suggested") return;
    const picks = analyze.result.suggested_fields.filter((f) => selectedKeys.includes(f.key));
    if (picks.length === 0) return;
    const fields = picks.map((f) => f.label).join(", ");
    const shapes = picks.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.shape?.kind || "unknown",
      item_keys: f.shape?.item_keys || null,
    }));
    await chrome.runtime.sendMessage({
      type: "ADD_EXTRACT_STEP",
      fields,
      shapes,
      pageUrl: analyze.result.page_url,
      pageTitle: analyze.result.page_title || "",
      pageSnapshot: {
        page_url: analyze.result.page_url,
        page_title: analyze.result.page_title || "",
        visible_text: analyze.result.visible_text,
        dom_snippet: analyze.result.dom_snippet,
        captured_at: new Date().toISOString(),
      },
      pageSnapshots: analyze.result.page_snapshots,
      timestamp: new Date().toISOString(),
    });
    setAnalyze({ type: "applied", count: picks.length });
    setSelectedKeys([]);
  };

  return (
    <Section>
      <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginBottom: 8 }}>
        Analyze this page
      </div>
      {analyze.type === "idle" && (
        <>
          <p style={{ color: colors.muted, fontSize: 11, margin: "0 0 8px" }}>
            Mark which fields to extract from the page you're currently on. The page is captured now and saved with the step so you can edit fields later without revisiting.
          </p>
          <button style={btn()} onClick={handleAnalyze}>Analyze this page</button>
        </>
      )}
      {analyze.type === "loading" && (
        <p style={{ color: colors.muted, fontSize: 12, margin: 0 }}>Analyzing the active tab…</p>
      )}
      {analyze.type === "suggested" && (
        <>
          <p style={{ color: colors.muted, fontSize: 11, margin: "0 0 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {analyze.result.page_title || analyze.result.page_url}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", marginBottom: 8 }}>
            {analyze.result.suggested_fields.map((field) => {
              const checked = selectedKeys.includes(field.key);
              return (
                <label key={field.key} style={{
                  display: "flex", alignItems: "flex-start", gap: 8,
                  padding: 8, border: `1px solid ${colors.border}`,
                  borderRadius: 6, cursor: "pointer", background: "#15182040",
                }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      setSelectedKeys((prev) =>
                        e.target.checked
                          ? [...prev, field.key]
                          : prev.filter((k) => k !== field.key),
                      );
                    }}
                    style={{ marginTop: 2 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: colors.text }}>
                      <span style={{ fontWeight: 500 }}>{field.label}</span>
                      <ShapeBadge kind={field.shape?.kind} />
                    </div>
                    {field.description && (
                      <div style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>{field.description}</div>
                    )}
                  </div>
                </label>
              );
            })}
            {analyze.result.suggested_fields.length === 0 && (
              <p style={{ color: colors.muted, fontSize: 12 }}>No fields suggested for this page.</p>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              style={ghostBtn()}
              onClick={() => { setAnalyze({ type: "idle" }); setSelectedKeys([]); }}
            >Cancel</button>
            <button
              style={btn({ opacity: selectedKeys.length === 0 ? 0.5 : 1 })}
              disabled={selectedKeys.length === 0}
              onClick={handleApply}
            >Apply ({selectedKeys.length})</button>
          </div>
        </>
      )}
      {analyze.type === "error" && (
        <>
          <p style={{ color: colors.red, fontSize: 12, margin: "0 0 8px" }}>{analyze.message}</p>
          <button style={ghostBtn(colors.blue)} onClick={handleAnalyze}>Try again</button>
        </>
      )}
      {analyze.type === "applied" && (
        <>
          <p style={{ color: colors.green, fontSize: 12, margin: "0 0 8px" }}>
            ✓ {analyze.count} field{analyze.count === 1 ? "" : "s"} added to this recording.
          </p>
          <button style={ghostBtn(colors.blue)} onClick={() => setAnalyze({ type: "idle" })}>
            Analyze another page
          </button>
        </>
      )}
    </Section>
  );
}

function RecordingView({ stepCount }: { stepCount: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Section>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Dot color={colors.red} pulse />
          <span style={{ color: colors.red, fontWeight: 600, fontSize: "13px" }}>
            Recording — {stepCount} step{stepCount !== 1 ? "s" : ""} captured
          </span>
        </div>
      </Section>
      <AnalyzePageSection />
      <button style={btn({ background: "#242836", border: `1px solid ${colors.border}` })}
        onClick={() => send({ type: "STOP_RECORDING" })}>
        ■ Stop Recording
      </button>
    </div>
  );
}

function RunningView({
  workflowName, currentStep, totalSteps, runId, label = "Running",
}: {
  workflowName: string; currentStep: number; totalSteps: number; runId: string; label?: string;
}) {
  const pct = totalSteps > 0 ? Math.round(((currentStep + 1) / totalSteps) * 100) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Section>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <Dot color={colors.blue} pulse />
          <span style={{ color: colors.blue, fontWeight: 600, fontSize: "13px" }}>{label}</span>
        </div>
        <div style={{ fontSize: "13px", color: colors.text, marginBottom: "6px" }}>{workflowName}</div>
        <div style={{ fontSize: "11px", color: colors.muted, marginBottom: "8px" }}>
          Step {currentStep + 1} of {totalSteps} · {pct}%
        </div>
        <ProgressBar pct={pct} />
      </Section>
      <button style={ghostBtn(colors.blue)}
        onClick={() => openDashboard(`/runs/${runId}`)}>
        View Run →
      </button>
      <button style={ghostBtn(colors.red)}
        onClick={() => send({ type: "CANCEL_RUN", runId })}>
        Cancel Run
      </button>
    </div>
  );
}

function WaitingView({ reason, runId }: { reason: string; runId?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Section>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <span style={{ fontSize: "16px" }}>⚠️</span>
          <span style={{ color: colors.yellow, fontWeight: 600, fontSize: "13px" }}>Action Required</span>
        </div>
        <p style={{ color: colors.text, fontSize: "12px", margin: 0 }}>{reason}</p>
      </Section>
      <button style={btn()} onClick={() => send({ type: "RESUME_RUN" })}>
        I've Handled It → Resume
      </button>
      {runId && (
        <button style={ghostBtn(colors.blue)} onClick={() => openDashboard(`/runs/${runId}`)}>
          View Run →
        </button>
      )}
    </div>
  );
}

function FailedView({ error, runId }: { error: string; runId?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Section>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
          <Dot color={colors.red} />
          <span style={{ color: colors.red, fontWeight: 600, fontSize: "13px" }}>Run Failed</span>
        </div>
        <p style={{ color: colors.muted, fontSize: "12px", margin: 0 }}>{error}</p>
      </Section>
      {runId && (
        <button style={ghostBtn(colors.blue)} onClick={() => openDashboard(`/runs/${runId}`)}>
          View Run →
        </button>
      )}
      <button style={ghostBtn()} onClick={() => openDashboard()}>
        Open Dashboard
      </button>
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

function SidePanel() {
  const [state, setState] = useState<PopupState>({ type: "idle" });

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
      if (response?.state?.type) setState(response.state as PopupState);
    });
    const listener = (message: { type: string; state?: PopupState }) => {
      if (message.type === "STATE_UPDATE" && message.state?.type) {
        setState(message.state);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function renderContent() {
    switch (state.type) {
      case "idle":
        return <IdleView />;

      case "recording":
        return <RecordingView stepCount={state.step_count} />;

      case "running":
      case "running_parameterized":
        return (
          <RunningView
            workflowName={state.workflow_name}
            currentStep={state.current_step}
            totalSteps={state.total_steps}
            runId={state.run_id}
          />
        );

      case "recovering":
        return (
          <RunningView
            workflowName={state.workflow_name}
            currentStep={state.current_step}
            totalSteps={state.total_steps}
            runId={state.run_id}
            label="Auto-Healing…"
          />
        );

      case "waiting_for_user":
        return <WaitingView reason={state.reason} runId={state.run_id} />;

      case "failed":
        return <FailedView error={state.error} runId={state.run_id} />;

      case "error":
        return <FailedView error={state.message} />;

      default:
        return <IdleView />;
    }
  }

  const stateLabel: Record<string, string> = {
    idle: "Ready",
    recording: "Recording",
    running: "Running",
    running_parameterized: "Running",
    recovering: "Healing",
    waiting_for_user: "Needs Attention",
    failed: "Failed",
    error: "Error",
    setting_goal: "Setting Goal",
  };

  return (
    <div style={{
      padding: "16px", color: colors.text, background: colors.bg,
      minHeight: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      boxSizing: "border-box",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <h2 style={{ fontSize: "14px", fontWeight: 600, margin: 0 }}>Session Replay</h2>
        <span style={{
          fontSize: "11px", padding: "2px 8px", borderRadius: "999px",
          background: `${state.type === "running" || state.type === "running_parameterized" || state.type === "recovering" ? colors.blue : state.type === "waiting_for_user" ? colors.yellow : state.type === "failed" || state.type === "error" ? colors.red : state.type === "recording" ? colors.red : colors.green}22`,
          color: state.type === "running" || state.type === "running_parameterized" || state.type === "recovering" ? colors.blue : state.type === "waiting_for_user" ? colors.yellow : state.type === "failed" || state.type === "error" ? colors.red : state.type === "recording" ? colors.red : colors.green,
          fontWeight: 500,
        }}>
          {stateLabel[state.type] ?? state.type}
        </span>
      </div>
      {renderContent()}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
