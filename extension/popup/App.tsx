import { useEffect, useState } from "react";
import type { PopupState } from "../src/shared/types";

function App() {
  const [state, setState] = useState<PopupState>({ type: "idle" });

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
      if (response?.state) setState(response.state);
    });

    const listener = (message: { type: string; state: PopupState }) => {
      if (message.type === "STATE_UPDATE") setState(message.state);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const toggleRecording = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;

    if (state.type === "recording") {
      chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
      chrome.tabs.sendMessage(tab.id, { type: "SET_RECORDING", enabled: false });
      setState({ type: "idle" });
    } else {
      chrome.runtime.sendMessage({ type: "START_RECORDING" });
      chrome.tabs.sendMessage(tab.id, { type: "SET_RECORDING", enabled: true });
      setState({ type: "recording", step_count: 0 });
    }
  };

  return (
    <div style={{ padding: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <span style={{ fontSize: "15px", fontWeight: 600 }}>Session Replay</span>
        <span style={{
          display: "flex", alignItems: "center", gap: "6px",
          color: "#00B894", fontSize: "12px",
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#00B894" }} />
          Connected
        </span>
      </div>

      {state.type === "idle" && <IdleView onRecord={toggleRecording} />}
      {state.type === "recording" && <RecordingView stepCount={state.step_count} onStop={toggleRecording} />}
      {state.type === "running" && (
        <RunningView
          workflowName={state.workflow_name}
          currentStep={state.current_step}
          totalSteps={state.total_steps}
          runId={state.run_id}
        />
      )}
      {state.type === "waiting_for_user" && <WaitingView reason={state.reason} />}
      {state.type === "error" && <ErrorView message={state.message} />}
    </div>
  );
}

function IdleView({ onRecord }: { onRecord: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <button
        onClick={onRecord}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          padding: "12px", borderRadius: "6px", border: "none",
          background: "#E17055", color: "#fff", fontSize: "14px", fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#fff" }} />
        Record Workflow
      </button>
      <button
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          padding: "12px", borderRadius: "6px", border: "none",
          background: "#242836", color: "#E8EAED", fontSize: "14px", fontWeight: 500,
          cursor: "pointer",
        }}
      >
        ▶ Run Workflow
      </button>
      <div style={{
        padding: "12px", borderRadius: "6px", background: "#1A1D27",
        textAlign: "center", color: "#9AA0B0", fontSize: "12px",
      }}>
        No active workflows. Start recording to create one.
      </div>
    </div>
  );
}

function RecordingView({ stepCount, onStop }: { stepCount: number; onStop: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "8px",
        padding: "8px 12px", borderRadius: "6px", background: "rgba(225,112,85,0.15)",
      }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", background: "#E17055",
          animation: "pulse 1.5s infinite",
        }} />
        <span style={{ color: "#E17055", fontWeight: 500, fontSize: "13px" }}>
          Recording... {stepCount} step{stepCount !== 1 ? "s" : ""}
        </span>
        <style>{`
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        `}</style>
      </div>

      <button
        onClick={onStop}
        style={{
          padding: "10px", borderRadius: "6px", border: "none",
          background: "#242836", color: "#E8EAED", fontSize: "13px",
          cursor: "pointer",
        }}
      >
        ■ Stop Recording
      </button>
    </div>
  );
}

function RunningView({
  workflowName, currentStep, totalSteps, runId,
}: {
  workflowName: string; currentStep: number; totalSteps: number; runId: string;
}) {
  const pct = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{
        padding: "8px 12px", borderRadius: "6px", background: "rgba(116,185,255,0.15)",
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
        <span style={{ color: "#9AA0B0", fontSize: "11px", marginTop: "4px", display: "block" }}>
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
        ⏸ Pause
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

function WaitingView({ reason }: { reason: string }) {
  return (
    <div style={{
      padding: "12px", borderRadius: "6px",
      background: "rgba(253,203,110,0.15)", border: "1px solid rgba(253,203,110,0.3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "16px" }}>⚠</span>
        <span style={{ fontWeight: 500, color: "#FDCB6E" }}>Action Required</span>
      </div>
      <p style={{ color: "#E8EAED", fontSize: "12px", marginBottom: "8px" }}>{reason}</p>
      <button
        onClick={() => chrome.runtime.sendMessage({ type: "RESUME_RUN" })}
        style={{
          padding: "8px 16px", borderRadius: "6px", border: "none",
          background: "#6C5CE7", color: "#fff", fontSize: "12px", cursor: "pointer",
        }}
      >
        I've Handled It → Resume
      </button>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div style={{
      padding: "12px", borderRadius: "6px",
      background: "rgba(225,112,85,0.15)", border: "1px solid rgba(225,112,85,0.3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "16px" }}>✗</span>
        <span style={{ fontWeight: 500, color: "#E17055" }}>Error</span>
      </div>
      <p style={{ color: "#E8EAED", fontSize: "12px" }}>{message}</p>
    </div>
  );
}

export default App;
