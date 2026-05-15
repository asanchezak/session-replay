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
  onRun: (values: Record<string, string>) => void;
  onCancel: () => void;
  isRunning?: boolean;
}

export function RunParameterModal({
  parameters,
  onRun,
  onCancel,
  isRunning,
}: RunParameterModalProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of parameters) {
      initial[p.key] = p.default || "";
    }
    return initial;
  });

  const handleChange = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = () => {
    onRun(values);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-[#242836] rounded-2xl border border-[#2D3148] shadow-lg w-full max-w-lg mx-4 p-6">
        <h2 className="text-lg font-semibold text-[#E8EAED] mb-1">
          Run with Parameters
        </h2>
        <p className="text-sm text-[#9AA0B0] mb-4">
          Configure runtime parameters before executing this workflow.
        </p>

        <div className="max-h-[60vh] overflow-y-auto mb-6">
          <ParameterForm
            parameters={parameters}
            values={values}
            onChange={handleChange}
            readOnly={isRunning}
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={isRunning}
            className="px-4 py-2 rounded-lg border border-[#2D3148] text-sm text-[#9AA0B0] hover:bg-[#2A2E3D] disabled:opacity-50"
          >
            Cancel
          </button>
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
              "Run Workflow"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
