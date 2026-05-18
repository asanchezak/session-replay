import { useState } from "react";
import { ParameterForm } from "./ParameterForm";

interface Parameter {
  key: string;
  type: "string" | "number" | "boolean" | "list";
  default: string | null;
  description: string | null;
  confidence: number;
  required: boolean;
}

interface RunParameterModalProps {
  parameters: Parameter[];
  onRun: (values: Record<string, string>, goal?: string) => void;
  onCancel: () => void;
  isRunning?: boolean;
  includeGoal?: boolean;
  goalLabel?: string;
  goalPlaceholder?: string;
  title?: string;
  description?: string;
  startLabel?: string;
  skipLabel?: string;
  onSkip?: () => void;
}

export function RunParameterModal({
  parameters,
  onRun,
  onCancel,
  isRunning,
  includeGoal,
  goalLabel = "Execution goal",
  goalPlaceholder = 'e.g. "Extract the first 10 job descriptions from this search"',
  title = "Run with Parameters",
  description = "Configure runtime parameters before executing this workflow.",
  startLabel = "Run Workflow",
  skipLabel = "Run As Recorded",
  onSkip,
}: RunParameterModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of parameters) {
      initial[p.key] = p.default || "";
    }
    return initial;
  });
  const [goal, setGoal] = useState("");

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    const trimmedGoal = goal.trim();
    onRun(values, trimmedGoal || undefined);
  };
  const headingId = "run-parameter-modal-title";
  const descriptionId = "run-parameter-modal-description";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        className="bg-[#242836] rounded-2xl border border-[#2D3148] shadow-lg w-full max-w-lg mx-4 p-6"
      >
        <h2 id={headingId} className="text-lg font-semibold text-[#E8EAED] mb-1">
          {title}
        </h2>
        <p id={descriptionId} className="text-sm text-[#9AA0B0] mb-4">
          {description}
        </p>

        <div className="max-h-[60vh] overflow-y-auto mb-6">
          <div className="space-y-4">
            {parameters.length > 0 && (
              <ParameterForm
                parameters={parameters}
                values={values}
                onChange={handleChange}
                readOnly={isRunning}
              />
            )}
            {includeGoal && (
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="execution-goal"
                  className="text-[#E8EAED] text-sm font-medium"
                >
                  {goalLabel}
                </label>
                <textarea
                  id="execution-goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder={goalPlaceholder}
                  rows={3}
                  disabled={isRunning}
                  className={`rounded-lg border border-[#2D3148] bg-[#2A2E3D] px-3 py-2 text-sm text-[#E8EAED] placeholder-[#6B7280] focus:outline-none focus:ring-1 focus:ring-[#6C5CE7] resize-y ${
                    isRunning ? "opacity-60 cursor-not-allowed" : ""
                  }`}
                />
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isRunning}
            className="px-4 py-2 rounded-lg border border-[#2D3148] text-sm text-[#9AA0B0] hover:bg-[#2A2E3D] disabled:opacity-50"
          >
            Cancel
          </button>
          {onSkip && (
            <button
              onClick={onSkip}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg border border-[#2D3148] text-sm text-[#E8EAED] hover:bg-[#2A2E3D] disabled:opacity-50"
            >
              {skipLabel}
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={isRunning}
            className="px-4 py-2 rounded-lg bg-[#6C5CE7] text-sm text-white font-medium hover:bg-[#7C6EF7] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isRunning ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Running...
              </>
            ) : (
              startLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
