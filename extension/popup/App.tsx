import { useEffect, useState } from "react";
import type { PopupState } from "../src/shared/types";
import { IdleView } from "./IdleView";
import { RecordingView } from "./RecordingView";
import { RunningView } from "./RunningView";
import { WaitingView } from "./WaitingView";
import { ErrorView } from "./ErrorView";

const API_BASE = "http://localhost:8081/v1";

function App() {
  const [state, setState] = useState<PopupState>({ type: "idle" });
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [lastRecordedId, setLastRecordedId] = useState<string | null>(null);
  const [recordedPrompt, setRecordedPrompt] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);

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

  const sendMessage = (msg: any): Promise<any> => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || {});
      });
    });
  };

  const loadWorkflows = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await sendMessage({ type: "FETCH_WORKFLOWS" });
      if (resp.error && resp.error.includes("Receiving end")) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      setWorkflows(resp?.workflows || []);
      break;
    }
    setShowWorkflows(true);
  };

  const runWorkflow = async (workflowId: string) => {
    setRunning(workflowId);
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await sendMessage({ type: "RUN_WORKFLOW", workflowId });
      if (resp.error && resp.error.includes("Receiving end")) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (resp?.status === "running" || resp?.run?.status === "running") {
        success = true;
      }
      break;
    }
    setRunning(null);
    if (success) {
      setShowWorkflows(false);
    }
  };

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

  const handleStopRecording = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.id) return;
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    chrome.tabs.sendMessage(tab.id, { type: "SET_RECORDING", enabled: false });
    setState({ type: "idle" });

    // Fetch latest workflow in background for potential prompt editing
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const resp = await sendMessage({ type: "FETCH_WORKFLOWS" });
      if (resp?.workflows?.length > 0) {
        const wf = resp.workflows[0];
        setLastRecordedId(wf.id);
        try {
          const promptResp = await fetch(`${API_BASE}/workflows/${wf.id}/generate-prompt`, {
            method: "POST",
            headers: { "X-API-Key": "dev-api-key-change-in-production" },
          });
          if (promptResp.ok) {
            const data = await promptResp.json();
            setRecordedPrompt(data.prompt);
          }
        } catch {
          // AI not available
        }
        break;
      }
    }
  };

  return (
    <div style={{ padding: "16px" }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: "16px",
      }}>
        <span style={{ fontSize: "15px", fontWeight: 600 }}>Session Replay</span>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            onClick={openDashboard}
            title="Open Dashboard"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "#9AA0B0", padding: "2px", display: "flex",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "#9AA0B0", padding: "2px", display: "flex",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          </button>
          <span style={{
            display: "flex", alignItems: "center", gap: "6px",
            color: "#00B894", fontSize: "12px",
          }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#00B894" }} />
            Connected
          </span>
        </div>
      </div>

      {state.type === "idle" && !showWorkflows && (
        <IdleView
          onRecord={toggleRecording}
          onRun={loadWorkflows}
          lastRecordedId={lastRecordedId}
          recordedPrompt={recordedPrompt}
          onShowPrompt={() => setLastRecordedId(null)} // dismissed
        />
      )}
      {state.type === "idle" && showWorkflows && (
        <WorkflowListView
          workflows={workflows}
          running={running}
          onRun={runWorkflow}
          onBack={() => setShowWorkflows(false)}
        />
      )}
      {state.type === "recording" && (
        <RecordingView stepCount={state.step_count} onStop={handleStopRecording} />
      )}
      {state.type === "running" && (
        <RunningView
          workflowName={state.workflow_name}
          currentStep={state.current_step}
          totalSteps={state.total_steps}
          runId={state.run_id}
        />
      )}
      {state.type === "recovering" && (
        <RecoveringView
          workflowName={state.workflow_name}
          currentStep={state.current_step}
          totalSteps={state.total_steps}
          error={state.error}
        />
      )}
      {state.type === "waiting_for_user" && <WaitingView reason={state.reason} />}
      {state.type === "error" && <ErrorView message={state.message} />}
      {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
    </div>
  );
}

const DASHBOARD_URL = "http://localhost:5173/dashboard";

function openDashboard() {
  chrome.tabs.create({ url: DASHBOARD_URL });
}

function WorkflowListView({
  workflows, running, onRun, onBack,
}: {
  workflows: Array<{ id: string; name: string }>;
  running: string | null;
  onRun: (id: string) => void;
  onBack: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 500, color: "#E8EAED" }}>
          Select Workflow
        </span>
        <button
          onClick={onBack}
          style={{
            background: "none", border: "none", color: "#6C5CE7",
            fontSize: "12px", cursor: "pointer", padding: "4px",
          }}
        >
          ← Back
        </button>
      </div>
      {workflows.length === 0 && (
        <div style={{
          padding: "16px", borderRadius: "6px", background: "#1A1D27",
          textAlign: "center", color: "#9AA0B0", fontSize: "12px",
        }}>
          No workflows yet. Record one first.
        </div>
      )}
      <div style={{
        maxHeight: "300px", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: "4px",
      }}>
        {workflows.map((wf) => (
          <button
            key={wf.id}
            onClick={() => onRun(wf.id)}
            disabled={running === wf.id}
            style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "10px 12px", borderRadius: "6px", border: "1px solid #2D3148",
              background: running === wf.id ? "#6C5CE7" : "#1A1D27",
              color: "#E8EAED", fontSize: "12px", cursor: "pointer",
              textAlign: "left", width: "100%",
            }}
          >
            <span style={{
              overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap", flex: 1,
            }}>
              {wf.name}
            </span>
            <span style={{
              color: running === wf.id ? "#fff" : "#6C5CE7",
              fontSize: "11px", marginLeft: "8px",
            }}>
              {running === wf.id ? "Starting..." : "▶ Run"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecoveringView({
  workflowName, currentStep, totalSteps, error,
}: {
  workflowName: string; currentStep: number; totalSteps: number; error: string;
}) {
  return (
    <div style={{
      padding: "12px", borderRadius: "6px",
      background: "rgba(116,185,255,0.1)",
      border: "1px solid rgba(116,185,255,0.25)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{
          width: 10, height: 10, borderRadius: "50%", background: "#74B9FF",
          animation: "pulse 1.5s infinite",
        }} />
        <span style={{ fontWeight: 500, color: "#74B9FF", fontSize: "13px" }}>
          Auto-Healing...
        </span>
        <style>{`
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        `}</style>
      </div>
      <div style={{ fontSize: "12px", color: "#9AA0B0" }}>
        <p style={{ marginBottom: "4px" }}>
          {workflowName} — Step {currentStep}/{totalSteps}
        </p>
        <p style={{ color: "#E8EAED", fontSize: "11px" }}>{error}</p>
      </div>
    </div>
  );
}

function SettingsView({ onClose }: { onClose: () => void }) {
  const [aiKey, setAiKey] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.session.get(["aiApiKey", "apiBaseUrl", "apiKey"]).then((r) => {
      if (r.aiApiKey) setAiKey(r.aiApiKey as string);
      if (r.apiBaseUrl) setApiUrl(r.apiBaseUrl as string);
      else setApiUrl("http://localhost:8081/v1");
      if (r.apiKey) setAuthKey(r.apiKey as string);
      else setAuthKey("dev-api-key-change-in-production");
    });
  }, []);

  const save = async () => {
    setSaving(true);
    await chrome.storage.session.set({
      aiApiKey: aiKey,
      apiBaseUrl: apiUrl,
      apiKey: authKey,
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 500 }}>Settings</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#6C5CE7", fontSize: "12px", cursor: "pointer" }}>
          ← Back
        </button>
      </div>
      <label style={{ fontSize: "11px", color: "#9AA0B0" }}>OpenAI API Key</label>
      <input
        type="password"
        value={aiKey}
        onChange={(e) => setAiKey(e.target.value)}
        placeholder="sk-..."
        style={{
          width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #2D3148",
          background: "#1A1D27", color: "#E8EAED", fontSize: "12px", boxSizing: "border-box",
        }}
      />
      <label style={{ fontSize: "11px", color: "#9AA0B0" }}>Backend URL</label>
      <input
        value={apiUrl}
        onChange={(e) => setApiUrl(e.target.value)}
        placeholder="http://localhost:8081/v1"
        style={{
          width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #2D3148",
          background: "#1A1D27", color: "#E8EAED", fontSize: "12px", boxSizing: "border-box",
        }}
      />
      <label style={{ fontSize: "11px", color: "#9AA0B0" }}>Auth Key</label>
      <input
        type="password"
        value={authKey}
        onChange={(e) => setAuthKey(e.target.value)}
        placeholder="dev-api-key-change-in-production"
        style={{
          width: "100%", padding: "8px", borderRadius: "6px", border: "1px solid #2D3148",
          background: "#1A1D27", color: "#E8EAED", fontSize: "12px", boxSizing: "border-box",
        }}
      />
      <button
        onClick={save}
        disabled={saving}
        style={{
          padding: "10px", borderRadius: "6px", border: "none",
          background: "#6C5CE7", color: "#fff", fontSize: "13px",
          fontWeight: 500, cursor: "pointer", opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? "Saving..." : saved ? "✓ Saved" : "Save"}
      </button>
    </div>
  );
}

export default App;
