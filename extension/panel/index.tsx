import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type PanelState = "idle" | "recording" | "running" | "waiting_for_user" | "recovering" | "failed";

function SidePanel() {
  const [state, setState] = useState<PanelState>("idle");

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
      if (response?.state?.type) setState(response.state.type);
    });

    const listener = (message: { type: string; state?: { type: PanelState } }) => {
      if (message.type === "STATE_UPDATE" && message.state?.type) {
        setState(message.state.type);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  return (
    <div style={{ padding: "16px" }}>
      <h2 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>
        Workflow Panel
      </h2>
      <div style={{
        padding: "8px 12px", borderRadius: "6px",
        background: state === "recording" ? "rgba(225,112,85,0.15)" :
                    state === "running" ? "rgba(116,185,255,0.15)" :
                    state === "waiting_for_user" ? "rgba(253,203,110,0.15)" :
                    state === "recovering" ? "rgba(116,185,255,0.1)" :
                    state === "failed" ? "rgba(225,112,85,0.15)" :
                    "rgba(154,160,176,0.1)",
        color: state === "recording" ? "#E17055" :
               state === "running" ? "#74B9FF" :
               state === "waiting_for_user" ? "#FDCB6E" :
               state === "recovering" ? "#74B9FF" :
               state === "failed" ? "#E17055" :
               "#9AA0B0",
        fontSize: "13px", fontWeight: 500,
      }}>
        Status: {state}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
