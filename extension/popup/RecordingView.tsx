interface RecordingViewProps {
  stepCount: number;
  onStop: () => void;
}

export function RecordingView({ stepCount, onStop }: RecordingViewProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: "8px",
        padding: "8px 12px", borderRadius: "6px",
        background: "rgba(225,112,85,0.15)",
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
