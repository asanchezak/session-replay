interface OutputSchemaPreviewProps {
  outputType: string;
  schema: Record<string, unknown> | null;
  confidence: number;
  onAnalyze?: () => void;
}

export function OutputSchemaPreview({ outputType, schema, confidence, onAnalyze }: OutputSchemaPreviewProps) {
  const hasSchema = schema && schema !== null && Object.keys(schema).length > 0;

  return (
    <div className="rounded-lg border border-[#2D3148] bg-[#1A1D27] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-[#E8EAED]">Expected Output</span>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: confidence > 0.8 ? "rgba(0,184,148,0.15)" : "rgba(253,203,110,0.15)",
            color: confidence > 0.8 ? "#00B894" : "#FDCB6E",
          }}
        >
          {Math.round(confidence * 100)}% confidence
        </span>
      </div>
      <div className="text-sm">
        <span className="text-[#9AA0B0]">Type: </span>
        <span className="text-[#E8EAED] capitalize">{outputType.replace(/_/g, " ")}</span>
      </div>
      {hasSchema && (
        <pre className="mt-2 p-2 rounded bg-[#0F1117] text-xs text-[#74B9FF] overflow-x-auto max-h-32 font-mono">
          {JSON.stringify(schema, null, 2)}
        </pre>
      )}
      {!hasSchema && (
        <div className="mt-2">
          <p className="text-xs text-[#6B7280] italic">
            No structured schema inferred yet.
          </p>
          {onAnalyze && (
            <button
              onClick={onAnalyze}
              className="mt-2 text-xs px-2 py-1 rounded-md bg-accent/10 text-accent border border-accent/30 hover:bg-accent/20 transition-colors"
            >
              Analyze workflow to detect output structure
            </button>
          )}
        </div>
      )}
    </div>
  );
}
