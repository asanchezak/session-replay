import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function SidePanel() {
  return (
    <div style={{ padding: "16px" }}>
      <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>
        Workflow Panel
      </h2>
      <p style={{ color: "#9AA0B0" }}>
        Side panel for detailed workflow inspection. Available during recording or replay.
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
