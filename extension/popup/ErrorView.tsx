interface ErrorViewProps {
  message: string;
}

export function ErrorView({ message }: ErrorViewProps) {
  return (
    <div style={{
      padding: "12px", borderRadius: "6px",
      background: "rgba(225,112,85,0.15)",
      border: "1px solid rgba(225,112,85,0.3)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "16px" }}>x</span>
        <span style={{ fontWeight: 500, color: "#E17055" }}>Error</span>
      </div>
      <p style={{ color: "#E8EAED", fontSize: "12px" }}>{message}</p>
    </div>
  );
}
