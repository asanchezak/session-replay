interface Phase {
  phase_index: number;
  phase_name: string;
  phase_goal: string | null;
  start_step_index: number;
  end_step_index: number;
}

interface PhaseTimelineProps {
  phases: Phase[];
  currentPhaseIndex?: number;
}

export function PhaseTimeline({ phases, currentPhaseIndex }: PhaseTimelineProps) {
  if (phases.length === 0) {
    return (
      <div className="text-[#9AA0B0] text-sm italic">
        No semantic phases detected.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {phases.map((phase) => {
        const isActive = currentPhaseIndex === phase.phase_index;
        const isPast = currentPhaseIndex !== undefined && phase.phase_index < currentPhaseIndex;

        return (
          <div
            key={phase.phase_index}
            className={`rounded-lg border p-3 ${
              isActive
                ? "border-[#6C5CE7] bg-[#6C5CE7]/10"
                : isPast
                  ? "border-[#00B894]/30 bg-[#00B894]/5"
                  : "border-[#2D3148] bg-[#1A1D27]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-[#E8EAED]">
                {phase.phase_index + 1}. {phase.phase_name}
              </span>
              <span className="text-xs text-[#9AA0B0]">
                Steps {phase.start_step_index + 1}–{phase.end_step_index + 1}
              </span>
            </div>
            {phase.phase_goal && (
              <p className="text-xs text-[#9AA0B0] mt-1">{phase.phase_goal}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
