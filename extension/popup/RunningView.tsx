interface RunningViewProps {
  workflowName: string;
  currentStep: number;
  totalSteps: number;
  runId: string;
}

export function RunningView({ workflowName, currentStep, totalSteps, runId }: RunningViewProps) {
  const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{
        padding: "8px 12px", borderRadius: "6px",
        background: "rgba(116,185,255,0.15)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
          <span style={{ color: "#74B9FF", fontWeight: 500, fontSize: "13px" }}>
            {workflowName}
          </span>
          <span style={{ color: "#9AA0B0", fontSize: "11px" }}>
            Step {currentStep}/{totalSteps}
          </span>
        </div>
        <div style={{
          height: 4, background: "#2A2E3D", borderRadius: 2, overflow: "hidden",
        }}>
          <div style={{
            width: `${pct}%`, height: "100%",
            background: "#74B9FF", borderRadius: 2,
            transition: "width 0.3s ease",
          }} />
        </div>
        <span style={{
          color: "#9AA0B0", fontSize: "11px",
          marginTop: "4px", display: "block",
        }}>
          {pct}% complete
        </span>
      </div>
      <button
        onClick={() => chrome.runtime.sendMessage({ type: "PAUSE_RUN", runId })}
        style={{
          padding: "10px", borderRadius: "6px", border: "none",
          background: "#242836", color: "#E8EAED", fontSize: "13px",
          cursor: "pointer",
        }}
      >
        Pause
      </button>
      <button
        onClick={() => chrome.runtime.sendMessage({ type: "VIEW_DETAILS", runId })}
        style={{
          padding: "8px", borderRadius: "6px", border: "1px solid #2D3148",
          background: "transparent", color: "#9AA0B0", fontSize: "12px",
          cursor: "pointer",
        }}
      >
        View Details
      </button>
    </div>
  );
}
