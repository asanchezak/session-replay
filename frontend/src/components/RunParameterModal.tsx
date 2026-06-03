import { useEffect, useState } from "react";
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
  onRun: (values: Record<string, string>, goal?: string, loadSession?: boolean) => void;
  onCancel: () => void;
  // When true, shows a "Cargar sesión del navegador" toggle (daemon Run path).
  showSessionToggle?: boolean;
  sessionToggleDefault?: boolean;
  isRunning?: boolean;
  prefilledValues?: Record<string, string>;
  parameterUsageLabels?: Record<string, string[]>;
  bindingPreviews?: Array<{
    parameter_key: string;
    connector?: { name: string; type: string };
    source_record?: { job_title?: string; job_id?: string };
    resolved_value?: string;
    target_summary?: string;
    error?: string;
  }>;
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
  prefilledValues,
  parameterUsageLabels,
  bindingPreviews,
  includeGoal,
  showSessionToggle,
  sessionToggleDefault = false,
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
      initial[p.key] = prefilledValues?.[p.key] || p.default || "";
    }
    return initial;
  });
  const [goal, setGoal] = useState("");
  const [loadSession, setLoadSession] = useState(sessionToggleDefault);

  useEffect(() => {
    if (!prefilledValues) return;
    setValues((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [key, value] of Object.entries(prefilledValues)) {
        if (typeof value === "string" && next[key] !== value) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [prefilledValues]);

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    const trimmedGoal = goal.trim();
    onRun(values, trimmedGoal || undefined, loadSession);
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
                usageLabels={parameterUsageLabels}
              />
            )}
            {bindingPreviews && bindingPreviews.length > 0 && (
              <div className="space-y-3">
                {bindingPreviews.map((preview) => (
                  <div key={preview.parameter_key} className="rounded-lg border border-[#2D3148] bg-[#1F2330] p-3">
                    <div className="flex items-center justify-between gap-3 mb-1">
                      <div className="text-sm text-[#E8EAED] font-medium">
                        {preview.parameter_key}
                      </div>
                      {preview.connector && (
                        <div className="text-xs text-[#9AA0B0]">
                          {preview.connector.name} ({preview.connector.type})
                        </div>
                      )}
                    </div>
                    {preview.error ? (
                      <p className="text-xs text-[#E17055]">{preview.error}</p>
                    ) : (
                      <>
                        {preview.source_record?.job_title && (
                          <p className="text-xs text-[#9AA0B0] mb-2">
                            Latest job: {preview.source_record.job_title}
                            {preview.source_record.job_id ? ` (#${preview.source_record.job_id})` : ""}
                          </p>
                        )}
                        {preview.target_summary && (
                          <p className="text-xs text-[#9AA0B0] mb-2">
                            Used by: {preview.target_summary}
                          </p>
                        )}
                        <p className="text-xs text-[#E8EAED] whitespace-pre-wrap break-words">
                          {preview.resolved_value}
                        </p>
                      </>
                    )}
                  </div>
                ))}
              </div>
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
            {showSessionToggle && (
              <div className="flex items-start justify-between gap-3 rounded-lg border border-[#2D3148] bg-[#1F2330] p-3">
                <div className="min-w-0">
                  <div className="text-sm text-[#E8EAED] font-medium">Cargar sesión del navegador</div>
                  <p className="text-xs text-[#9AA0B0] mt-0.5">
                    Usa las cookies de tu navegador para autenticarte en el sitio. Si está apagado, corre limpio/anónimo.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={loadSession}
                  onClick={() => setLoadSession((v) => !v)}
                  disabled={isRunning}
                  className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                    loadSession ? "bg-[#6C5CE7]" : "bg-[#2D3148]"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      loadSession ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
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
