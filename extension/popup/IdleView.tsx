import { useState } from "react";
import { getConfig } from "../src/background/api";

const API_BASE = "http://localhost:8081/v1";
const DASHBOARD_URL = "http://localhost:5173/dashboard";

function openDashboard() {
  chrome.tabs.create({ url: DASHBOARD_URL });
}

interface IdleViewProps {
  onRecord: () => void;
  onRun: () => void;
  lastRecordedId: string | null;
  recordedPrompt: string;
  onShowPrompt: () => void;
}

function RecordingCompleteView({
  workflowId, initialPrompt, onSave, onDashboard,
}: {
  workflowId: string; initialPrompt: string; onSave: () => void; onDashboard: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [saving, setSaving] = useState(false);

  const savePrompt = async () => {
    setSaving(true);
    try {
      const config = await getConfig();
      await fetch(`${API_BASE}/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
    } catch {
      // silently fail
    }
    setSaving(false);
    onSave();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{
        padding: "8px 12px", borderRadius: "6px",
        background: "rgba(0,184,148,0.12)",
      }}>
        <span style={{ color: "#00B894", fontWeight: 500, fontSize: "13px" }}>
          ✓ Workflow Saved
        </span>
      </div>
      <label style={{ fontSize: "12px", color: "#9AA0B0" }}>
        Describe what this workflow does:
      </label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        style={{
          width: "100%", padding: "8px", borderRadius: "6px",
          border: "1px solid #2D3148", background: "#1A1D27", color: "#E8EAED",
          fontSize: "12px", fontFamily: "inherit", resize: "none", boxSizing: "border-box",
        }}
        placeholder="e.g. Search for candidates on LinkedIn and sync to Odoo"
      />
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={savePrompt}
          disabled={saving}
          style={{
            flex: 1, padding: "10px", borderRadius: "6px", border: "none",
            background: "#6C5CE7", color: "#fff", fontSize: "13px",
            fontWeight: 500, cursor: "pointer", opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={onDashboard}
          style={{
            flex: 1, padding: "10px", borderRadius: "6px", border: "1px solid #2D3148",
            background: "transparent", color: "#74B9FF", fontSize: "13px",
            cursor: "pointer",
          }}
        >
          Open Dashboard
        </button>
      </div>
    </div>
  );
}

export function IdleView({ onRecord, onRun, lastRecordedId, recordedPrompt, onShowPrompt }: IdleViewProps) {
  const [editing, setEditing] = useState(false);

  if (editing && lastRecordedId) {
    return (
      <RecordingCompleteView
        workflowId={lastRecordedId}
        initialPrompt={recordedPrompt}
        onSave={() => { setEditing(false); onShowPrompt(); }}
        onDashboard={() => { openDashboard(); setEditing(false); }}
      />
    );
  }

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
        onClick={onRun}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          padding: "12px", borderRadius: "6px", border: "none",
          background: "#6C5CE7", color: "#fff", fontSize: "14px", fontWeight: 500,
          cursor: "pointer",
        }}
      >
        ▶ Run Workflow
      </button>
      <button
        onClick={openDashboard}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
          padding: "12px", borderRadius: "6px", border: "1px solid #2D3148",
          background: "transparent", color: "#74B9FF", fontSize: "14px", fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
        Dashboard
      </button>
      {lastRecordedId && (
        <button
          onClick={() => setEditing(true)}
          style={{
            padding: "8px 12px", borderRadius: "6px", border: "1px solid #00B894",
            background: "rgba(0,184,148,0.1)", color: "#00B894",
            fontSize: "12px", cursor: "pointer",
          }}
        >
          Edit Workflow Prompt
        </button>
      )}
      <div style={{
        padding: "12px", borderRadius: "6px", background: "#1A1D27",
        textAlign: "center", color: "#9AA0B0", fontSize: "12px",
      }}>
        No active workflows. Start recording to create one.
      </div>
    </div>
  );
}
