import { useState } from "react";

interface GoalInputViewProps {
  onStart: (goal: string) => void;
  onSkip: () => void;
}

export function GoalInputView({ onStart, onSkip }: GoalInputViewProps) {
  const [goal, setGoal] = useState("");

  const handleStart = () => {
    onStart(goal.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && goal.trim()) {
      handleStart();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div>
        <label
          style={{
            display: "block",
            fontSize: "13px",
            fontWeight: 500,
            color: "#E8EAED",
            marginBottom: "6px",
          }}
        >
          What are you trying to accomplish?
        </label>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='e.g. "Extract job descriptions for Python developers in Berlin from Indeed"'
          rows={3}
          autoFocus
          style={{
            width: "100%",
            padding: "8px",
            borderRadius: "6px",
            border: "1px solid #2D3148",
            background: "#2A2E3D",
            color: "#E8EAED",
            fontSize: "12px",
            boxSizing: "border-box",
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: "1.4",
          }}
        />
      </div>

      <div style={{ display: "flex", gap: "8px" }}>
        <button
          onClick={handleStart}
          disabled={!goal.trim()}
          style={{
            flex: 1,
            padding: "10px",
            borderRadius: "6px",
            border: "none",
            background: goal.trim() ? "#E17055" : "#2D3148",
            color: goal.trim() ? "#fff" : "#6B7280",
            fontSize: "13px",
            fontWeight: 500,
            cursor: goal.trim() ? "pointer" : "not-allowed",
          }}
        >
          Start Recording
        </button>
        <button
          onClick={onSkip}
          style={{
            padding: "10px 12px",
            borderRadius: "6px",
            border: "1px solid #2D3148",
            background: "transparent",
            color: "#9AA0B0",
            fontSize: "12px",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
