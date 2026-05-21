interface Parameter {
  key: string;
  type: "string" | "number" | "boolean" | "list";
  default: string | null;
  description: string | null;
  confidence: number;
  required: boolean;
}

interface ParameterFormProps {
  parameters: Parameter[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  readOnly?: boolean;
  usageLabels?: Record<string, string[]>;
}

export function ParameterForm({ parameters, values, onChange, readOnly, usageLabels }: ParameterFormProps) {
  if (parameters.length === 0) {
    return (
      <div className="text-[#9AA0B0] text-sm italic">
        No parameters configured for this workflow.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {parameters.map((param) => (
        <div key={param.key} className="flex flex-col gap-1">
          <label
            htmlFor={`param-${param.key}`}
            className="text-[#E8EAED] text-sm font-medium flex items-center gap-2"
          >
            <span>{param.key}</span>
            {param.required && (
              <span className="text-[#E17055] text-xs">*required</span>
            )}
            <span
              className="text-xs px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor:
                  param.confidence > 0.8
                    ? "rgba(0,184,148,0.15)"
                    : param.confidence > 0.5
                      ? "rgba(253,203,110,0.15)"
                      : "rgba(225,112,85,0.15)",
                color:
                  param.confidence > 0.8
                    ? "#00B894"
                    : param.confidence > 0.5
                      ? "#FDCB6E"
                      : "#E17055",
              }}
            >
              {Math.round(param.confidence * 100)}%
            </span>
          </label>
          {param.description && param.description !== param.key && (
            <span className="text-xs text-[#9AA0B0]">
              {param.description}
            </span>
          )}
          <input
            id={`param-${param.key}`}
            type={param.type === "number" ? "number" : "text"}
            value={values[param.key] || param.default || ""}
            onChange={(e) => onChange(param.key, e.target.value)}
            placeholder={param.default || ""}
            readOnly={readOnly}
            disabled={readOnly}
            className={`rounded-lg border border-[#2D3148] bg-[#2A2E3D] px-3 py-2 text-sm text-[#E8EAED] placeholder-[#6B7280] focus:outline-none focus:ring-1 focus:ring-[#6C5CE7] ${
              readOnly ? "opacity-60 cursor-not-allowed" : ""
            }`}
          />
          <span className="text-xs text-[#9AA0B0]">
            Type: {param.type}
          </span>
          {usageLabels?.[param.key] && usageLabels[param.key].length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {usageLabels[param.key].map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-[#2D3148] bg-[#1F2330] px-2 py-1 text-[11px] text-[#9AA0B0]"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
