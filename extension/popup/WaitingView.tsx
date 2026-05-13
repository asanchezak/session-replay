interface WaitingViewProps {
  reason: string;
}

export function WaitingView({ reason }: WaitingViewProps) {
  return (
    <div style={{
      padding: "12px", borderRadius: "6px",
      background: "rgba(253,203,110,0.15)",
      border: "1px solid rgba(253,203,110,0.3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "16px" }}>!</span>
        <span style={{ fontWeight: 500, color: "#FDCB6E" }}>Action Required</span>
      </div>
      <p style={{ color: "#E8EAED", fontSize: "12px", marginBottom: "8px" }}>{reason}</p>
      <button
        onClick={() => chrome.runtime.sendMessage({ type: "RESUME_RUN" })}
        style={{
          padding: "8px 16px", borderRadius: "6px", border: "none",
          background: "#6C5CE7", color: "#fff", fontSize: "12px",
          cursor: "pointer",
        }}
      >
        I've Handled It → Resume
      </button>
    </div>
  );
}
