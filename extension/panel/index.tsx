import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PopupState } from "../src/shared/types";

function PanelBadge({ label, color }: { label: string; color: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "4px 8px",
        borderRadius: "999px",
        fontSize: "12px",
        fontWeight: 500,
        background: `${color}22`,
        color,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function statusColor(type: PopupState["type"]): string {
  if (type === "recording") return "#E17055";
  if (type === "running" || type === "running_parameterized") return "#74B9FF";
  if (type === "waiting_for_user") return "#FDCB6E";
  if (type === "recovering") return "#74B9FF";
  if (type === "failed" || type === "error") return "#E17055";
  return "#9AA0B0";
}

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

  const details = useMemo(() => {
    if (state.type === "running" || state.type === "running_parameterized" || state.type === "recovering" || state.type === "failed") {
      return {
        runId: state.run_id,
        workflowName: state.workflow_name,
        step: `${state.current_step}/${state.total_steps}`,
        error: "error" in state ? state.error : "",
      };
    }
    if (state.type === "waiting_for_user") {
      return {
        runId: state.run_id,
        workflowName: "",
        step: "",
        error: state.reason,
      };
    }
    return { runId: "", workflowName: "", step: "", error: "" };
  }, [state]);

  return (
    <div style={{ padding: "16px", color: "#E8EAED" }} data-panel>
      <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "12px" }}>
        Workflow Panel
      </h2>

      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
        <PanelBadge label={state.type.replaceAll("_", " ")} color={statusColor(state.type)} />
      </div>

      {(details.workflowName || details.runId) && (
        <div style={{ border: "1px solid #2D3148", borderRadius: "8px", padding: "10px", marginBottom: "12px", background: "#1A1D27" }}>
          {details.workflowName && (
            <div style={{ fontSize: "13px", marginBottom: "6px" }}>{details.workflowName}</div>
          )}
          {details.runId && (
            <div style={{ fontSize: "12px", color: "#9AA0B0", marginBottom: "4px" }}>
              Run: {details.runId}
            </div>
          )}
          {details.step && (
            <div style={{ fontSize: "12px", color: "#9AA0B0" }}>Step: {details.step}</div>
          )}
        </div>
      )}

      {details.error && (
        <div style={{ fontSize: "12px", color: "#9AA0B0", border: "1px solid #2D3148", borderRadius: "8px", padding: "10px", background: "#1A1D27", marginBottom: "12px" }}>
          {details.error}
        </div>
      )}

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={() => chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => { if (response?.state) setState(response.state as PopupState); })}
          style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid #2D3148", background: "transparent", color: "#9AA0B0", cursor: "pointer", fontSize: "12px" }}
        >
          Refresh
        </button>
        <button
          onClick={() => chrome.runtime.sendMessage({ type: "VIEW_DETAILS", runId: details.runId })}
          disabled={!details.runId}
          style={{ padding: "8px 10px", borderRadius: "6px", border: "1px solid #2D3148", background: "transparent", color: details.runId ? "#74B9FF" : "#6B7280", cursor: details.runId ? "pointer" : "not-allowed", fontSize: "12px" }}
        >
          View Run
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
