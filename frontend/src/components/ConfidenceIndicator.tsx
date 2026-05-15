interface ConfidenceIndicatorProps {
  confidence: number;
  label?: string;
  size?: "sm" | "md";
}

export function ConfidenceIndicator({ confidence, label, size = "md" }: ConfidenceIndicatorProps) {
  const pct = Math.round(confidence * 100);
  const color =
    pct > 80 ? "#00B894" : pct > 50 ? "#FDCB6E" : "#E17055";

  const dims = size === "sm" ? { width: 40, height: 40, fontSize: 10 } : { width: 56, height: 56, fontSize: 13 };
  const radius = dims.width / 2 - 4;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex items-center gap-2">
      <svg width={dims.width} height={dims.height} className="flex-shrink-0">
        <circle
          cx={dims.width / 2}
          cy={dims.height / 2}
          r={radius}
          stroke="#2D3148"
          strokeWidth="3"
          fill="none"
        />
        <circle
          cx={dims.width / 2}
          cy={dims.height / 2}
          r={radius}
          stroke={color}
          strokeWidth="3"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${dims.width / 2} ${dims.height / 2})`}
          style={{ transition: "stroke-dashoffset 0.5s ease" }}
        />
        <text
          x={dims.width / 2}
          y={dims.height / 2 + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize={dims.fontSize}
          fontWeight="600"
          fontFamily="system-ui"
        >
          {pct}%
        </text>
      </svg>
      {label && <span className="text-sm text-[#E8EAED]">{label}</span>}
    </div>
  );
}
