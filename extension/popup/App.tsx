import { useEffect, useState } from "react";
import type { PopupState } from "../src/shared/types";
import { IdleView } from "./IdleView";
import { GoalInputView } from "./GoalInputView";
import { RecordingView } from "./RecordingView";
import { RunningView } from "./RunningView";
import { WaitingView } from "./WaitingView";
import { ErrorView } from "./ErrorView";
import { getConfig, DEV_DEFAULTS } from "../src/background/api";
import { API_BASE_URL, DASHBOARD_ORIGIN } from "../src/shared/constants";

type ServiceStatus = "checking" | "up" | "down";

type ConnStatus = {
  backend: ServiceStatus;
  dashboard: ServiceStatus;
  ai: ServiceStatus;
  workflows: ServiceStatus;
  runs: ServiceStatus;
};

function App() {
  const [state, setState] = useState<PopupState>({ type: "idle" });
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string; execution_mode?: string }>>([]);
  const [showWorkflows, setShowWorkflows] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [pendingRun, setPendingRun] = useState<{ id: string; name: string } | null>(null);
  const [daemonRun, setDaemonRun] = useState<{ id: string; name: string; status: string; current?: number; total?: number } | null>(null);
  const [lastRecordedId, setLastRecordedId] = useState<string | null>(null);
  const [recordedPrompt, setRecordedPrompt] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [connStatus, setConnStatus] = useState<ConnStatus>({
    backend: "checking",
    dashboard: "checking",
    ai: "checking",
    workflows: "checking",
    runs: "checking",
  });

  useEffect(() => {
    // Seed from last background check so status shows immediately
    chrome.storage.session.get("connStatus", (stored) => {
      const s = stored?.connStatus as Partial<ConnStatus> | undefined;
      if (s?.backend && s?.dashboard) {
        setConnStatus((prev) => ({
          ...prev,
          backend: s.backend ?? prev.backend,
          dashboard: s.dashboard ?? prev.dashboard,
          ai: s.ai ?? prev.ai,
          workflows: s.workflows ?? prev.workflows,
          runs: s.runs ?? prev.runs,
        }));
      }
    });

    const checkConnectivity = async () => {
      const config = await getConfig();
      const authHeaders = { "X-API-Key": config.apiKey };

      const [be, dash, wf, ru] = await Promise.allSettled([
        fetch(`${config.apiBase}/health`, { signal: AbortSignal.timeout(3000) }),
        fetch(DASHBOARD_ORIGIN, { method: "HEAD", signal: AbortSignal.timeout(3000) }),
        fetch(`${config.apiBase}/workflows?limit=1`, { headers: authHeaders, signal: AbortSignal.timeout(3000) }),
        fetch(`${config.apiBase}/runs?limit=1`, { headers: authHeaders, signal: AbortSignal.timeout(3000) }),
      ]);

      const backendUp = be.status === "fulfilled" && be.value.ok;
      let aiEnabled: ServiceStatus = "down";
      if (backendUp && be.status === "fulfilled") {
        try {
          const health = await be.value.clone().json() as { ai_enabled?: boolean };
          aiEnabled = health.ai_enabled ? "up" : "down";
        } catch {
          aiEnabled = "down";
        }
      }

      const next: ConnStatus = {
        backend: backendUp ? "up" : "down",
        dashboard: dash.status === "fulfilled" ? "up" : "down",
        ai: aiEnabled,
        workflows: !backendUp ? "down" : (wf.status === "fulfilled" && wf.value.ok) ? "up" : "down",
        runs: !backendUp ? "down" : (ru.status === "fulfilled" && ru.value.ok) ? "up" : "down",
      };
      setConnStatus(next);
      chrome.storage.session.set({ connStatus: next });
    };
    checkConnectivity();
    const interval = setInterval(checkConnectivity, 30_000);
    return () => clearInterval(interval);
  }, []);

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
    setPendingRun(null);
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

  const runWorkflow = async (workflowId: string, goal?: string) => {
    setRunning(workflowId);
    let success = false;
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const resp = await sendMessage({ type: "RUN_WORKFLOW", workflowId, goal });
      if (resp.error && resp.error.includes("Receiving end")) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if (resp?.error) {
        lastError = String(resp.error);
      }
      if (resp?.type === "RUN_STARTED" && resp?.run?.id) {
        success = true;
      } else if (resp?.type === "RUN_FAILED" && resp?.error) {
        lastError = String(resp.error);
      }
      break;
    }
    setRunning(null);
    if (success) {
      setShowWorkflows(false);
      setPendingRun(null);
      return;
    }
    setState({
      type: "error",
      message: lastError || "Failed to start workflow run",
    });
  };

  // Enqueue a run for the unattended daemon (no in-browser agent loop). The
  // daemon polls it up and drives it; we just show status + a dashboard link.
  const runOnDaemon = async (workflowId: string, name: string) => {
    setRunning(workflowId);
    const resp = await sendMessage({ type: "RUN_ON_DAEMON", workflowId });
    setRunning(null);
    if (resp?.type === "DAEMON_RUN_QUEUED" && resp?.run?.id) {
      setShowWorkflows(false);
      setDaemonRun({ id: resp.run.id, name, status: resp.run.status || "running", total: resp.run.total_steps });
      return;
    }
    setState({ type: "error", message: String(resp?.error || "Failed to enqueue daemon run") });
  };

  // Poll the daemon run's status while the view is open (popup is ephemeral;
  // the dashboard link is the durable view).
  useEffect(() => {
    if (!daemonRun?.id) return;
    if (["completed", "failed", "canceled"].includes(daemonRun.status)) return;
    const id = setInterval(async () => {
      const resp = await sendMessage({ type: "GET_RUN_STATUS", runId: daemonRun.id });
      if (resp?.type === "RUN_STATUS" && resp?.run) {
        setDaemonRun((prev) => prev && prev.id === resp.run.id
          ? { ...prev, status: resp.run.status, current: resp.run.current_step_index, total: resp.run.total_steps }
          : prev);
      }
    }, 2500);
    return () => clearInterval(id);
  }, [daemonRun?.id, daemonRun?.status]);

  const toggleRecording = async () => {
    const [tab] = await chrome.tabs.query({ url: ["*://*/*", "file://*/*"] });
    const activeTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!activeTab?.id) return;

    if (state.type === "recording") {
      chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
      chrome.tabs.sendMessage(activeTab.id, { type: "SET_RECORDING", enabled: false }).catch(() => {});
      setState({ type: "idle" });
    } else {
      // Show goal input first, then start recording
      setState({ type: "setting_goal" });
    }
  };

  const startRecordingWithGoal = async (goal: string) => {
    const [tab] = await chrome.tabs.query({ url: ["*://*/*", "file://*/*"] });
    const activeTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!activeTab?.id) return;
    if (goal) chrome.runtime.sendMessage({ type: "SET_RECORDING_GOAL", goal });
    chrome.runtime.sendMessage({ type: "START_RECORDING" });
    chrome.tabs.sendMessage(activeTab.id, { type: "SET_RECORDING", enabled: true }).catch(() => {});
    setState({ type: "recording", step_count: 0 });
  };

  const startRecordingWithoutGoal = () => {
    startRecordingWithGoal("");
  };

  const handleStopRecording = async () => {
    const [tab] = await chrome.tabs.query({ url: ["*://*/*", "file://*/*"] });
    const activeTab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!activeTab?.id) return;
    chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
    chrome.tabs.sendMessage(activeTab.id, { type: "SET_RECORDING", enabled: false }).catch(() => {});
    setState({ type: "idle" });

    // Fetch latest workflow in background for potential prompt editing
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      const resp = await sendMessage({ type: "FETCH_WORKFLOWS" });
      if (resp?.workflows?.length > 0) {
        const wf = resp.workflows[0];
        setLastRecordedId(wf.id);
        try {
          const config = await getConfig();
          const promptResp = await fetch(`${API_BASE_URL}/workflows/${wf.id}/generate-prompt`, {
            method: "POST",
            headers: { "X-API-Key": config.apiKey },
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
          <ConnectionStatusBadge
            backend={connStatus.backend}
            dashboard={connStatus.dashboard}
            ai={connStatus.ai}
            workflows={connStatus.workflows}
            runs={connStatus.runs}
          />
        </div>
      </div>

      {state.type === "idle" && !showWorkflows && (
        <IdleView
          onRecord={toggleRecording}
          onRun={loadWorkflows}
          lastRecordedId={lastRecordedId}
          recordedPrompt={recordedPrompt}
          onShowPrompt={() => setLastRecordedId(null)}
        />
      )}
      {state.type === "setting_goal" && (
        <GoalInputView
          onStart={(goal) => startRecordingWithGoal(goal)}
          onSkip={() => startRecordingWithoutGoal()}
        />
      )}
      {state.type === "idle" && pendingRun && (
        <GoalInputView
          label={`What should "${pendingRun.name}" accomplish on this run?`}
          placeholder='e.g. "Get the first 10 job descriptions from the current Indeed results"'
          startLabel="Run With Goal"
          skipLabel="Run As Recorded"
          onStart={(goal) => runWorkflow(pendingRun.id, goal)}
          onSkip={() => runWorkflow(pendingRun.id)}
        />
      )}
      {state.type === "idle" && showWorkflows && !pendingRun && !daemonRun && (
        <WorkflowListView
          workflows={workflows}
          running={running}
          onRun={(id, name) => setPendingRun({ id, name })}
          onRunDaemon={(id, name) => runOnDaemon(id, name)}
          onBack={() => setShowWorkflows(false)}
        />
      )}
      {state.type === "idle" && daemonRun && (
        <DaemonRunView
          run={daemonRun}
          onBack={() => { setDaemonRun(null); setShowWorkflows(false); }}
        />
      )}
      {state.type === "recording" && (
        <RecordingView
          stepCount={state.step_count}
          onStop={handleStopRecording}
        />
      )}
      {state.type === "running" && (
        <RunningView
          workflowName={state.workflow_name}
          currentStep={state.current_step}
          totalSteps={state.total_steps}
          runId={state.run_id}
        />
      )}
      {state.type === "running_parameterized" && (
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
      {state.type === "failed" && (
        <ErrorView
          message={`${state.workflow_name} failed at step ${state.current_step}/${state.total_steps}: ${state.error}`}
        />
      )}
      {state.type === "waiting_for_user" && <WaitingView reason={state.reason} />}
      {state.type === "error" && <ErrorView message={state.message} />}
      {showSettings && <SettingsView onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function openDashboard() {
  chrome.tabs.create({ url: `${DASHBOARD_ORIGIN}/dashboard` });
}

function WorkflowListView({
  workflows, running, onRun, onRunDaemon, onBack,
}: {
  workflows: Array<{ id: string; name: string; execution_mode?: string }>;
  running: string | null;
  onRun: (id: string, name: string) => void;
  onRunDaemon: (id: string, name: string) => void;
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
        {workflows.map((wf) => {
          const isGeneric = wf.execution_mode === "generic";
          const busy = running === wf.id;
          return (
            <div
              key={wf.id}
              style={{
                display: "flex", alignItems: "center", gap: "6px",
                padding: "8px 10px", borderRadius: "6px", border: "1px solid #2D3148",
                background: "#1A1D27",
              }}
            >
              <span style={{
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                flex: 1, color: "#E8EAED", fontSize: "12px",
              }} title={wf.name}>
                {wf.name}
              </span>
              <button
                onClick={() => onRun(wf.id, wf.name)}
                disabled={busy}
                title="Replay this workflow in your browser"
                style={{
                  border: "1px solid #6C5CE7", background: "transparent", color: "#6C5CE7",
                  borderRadius: "5px", padding: "5px 8px", fontSize: "11px", cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {busy ? "…" : "▶ Browser"}
              </button>
              {isGeneric && (
                <button
                  onClick={() => onRunDaemon(wf.id, wf.name)}
                  disabled={busy}
                  title="Run this workflow on the unattended daemon"
                  style={{
                    border: "none", background: "#6C5CE7", color: "#fff",
                    borderRadius: "5px", padding: "5px 8px", fontSize: "11px", cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {busy ? "…" : "☁ Daemon"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DaemonRunView({
  run, onBack,
}: {
  run: { id: string; name: string; status: string; current?: number; total?: number };
  onBack: () => void;
}) {
  const terminal = ["completed", "failed", "canceled"].includes(run.status);
  const color = run.status === "completed" ? "#00B894" : run.status === "failed" ? "#E17055" : "#6C5CE7";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "13px", fontWeight: 500, color: "#E8EAED" }}>☁ Running on daemon</span>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#6C5CE7", fontSize: "12px", cursor: "pointer" }}>← Back</button>
      </div>
      <div style={{ padding: "12px", borderRadius: "6px", background: "#1A1D27", display: "flex", flexDirection: "column", gap: "6px" }}>
        <span style={{ color: "#E8EAED", fontSize: "12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={run.name}>{run.name}</span>
        <span style={{ color, fontSize: "12px", fontWeight: 500 }}>
          {terminal ? run.status : "running"}{typeof run.current === "number" && typeof run.total === "number" && run.total > 0 ? ` · step ${run.current}/${run.total}` : ""}
        </span>
      </div>
      <button
        onClick={() => chrome.tabs.create({ url: `${DASHBOARD_ORIGIN}/runs/${run.id}` })}
        style={{ width: "100%", padding: "10px", borderRadius: "6px", border: "1px solid #2D3148", background: "transparent", color: "#74B9FF", fontSize: "12px", cursor: "pointer" }}
      >
        Open in dashboard ↗
      </button>
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
  const [apiUrl, setApiUrl] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    chrome.storage.session.get(["apiBaseUrl", "apiKey"]).then((r) => {
      if (r.apiBaseUrl) setApiUrl(r.apiBaseUrl as string);
      else setApiUrl(DEV_DEFAULTS.apiBase);
      if (r.apiKey) setAuthKey(r.apiKey as string);
      else setAuthKey(DEV_DEFAULTS.apiKey);
    });
  }, []);

  const save = async () => {
    setSaving(true);
    await chrome.storage.session.set({ apiBaseUrl: apiUrl, apiKey: authKey });
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
      <label style={{ fontSize: "11px", color: "#9AA0B0" }}>Backend URL</label>
      <input
        value={apiUrl}
        onChange={(e) => setApiUrl(e.target.value)}
        placeholder={DEV_DEFAULTS.apiBase}
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

function ConnectionStatusBadge({
  backend, dashboard, ai, workflows, runs,
}: {
  backend: ServiceStatus; dashboard: ServiceStatus; ai: ServiceStatus;
  workflows: ServiceStatus; runs: ServiceStatus;
}) {
  const checking = backend === "checking" || dashboard === "checking";
  const servicesUp = backend === "up" && dashboard === "up";
  const bothServicesDown = backend === "down" && dashboard === "down";
  const functionalDegraded = servicesUp && (workflows === "down" || runs === "down");

  let color: string;
  let label: string;
  if (checking) {
    color = "#9AA0B0";
    label = "Checking...";
  } else if (!servicesUp) {
    color = "#E17055";
    label = bothServicesDown ? "Offline" : backend === "down" ? "API offline" : "Dashboard offline";
  } else if (functionalDegraded) {
    color = "#E17055";
    label = workflows === "down" ? "Save unavailable" : "Replay unavailable";
  } else if (ai === "down") {
    color = "#FDCB6E";
    label = "AI disabled";
  } else {
    color = "#00B894";
    label = "Connected";
  }

  const s = (v: ServiceStatus, okText: string, failText: string) =>
    v === "checking" ? "…" : v === "up" ? `✓ ${okText}` : `✗ ${failText}`;

  const apiHost = new URL(API_BASE_URL).host;
  const dashHost = new URL(DASHBOARD_ORIGIN).host;
  const tooltip = [
    `Backend API (${apiHost}): ${s(backend, "online", "offline")}`,
    `Dashboard (${dashHost}): ${s(dashboard, "online", "offline")}`,
    `AI: ${s(ai, "enabled", "disabled — set AI_API_KEY in backend .env")}`,
    `Save workflows: ${s(workflows, "working", "unavailable — check DB / auth key")}`,
    `Replay runs: ${s(runs, "working", "unavailable — check DB / auth key")}`,
  ].join("\n");

  return (
    <span title={tooltip} style={{ display: "flex", alignItems: "center", gap: "6px", color, fontSize: "12px", cursor: "default", userSelect: "none" }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0 }} />
      {label}
    </span>
  );
}

export default App;
