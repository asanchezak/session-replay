import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { logger } from "../lib/logger";

interface InterventionModalProps {
  runId: string;
  runName?: string;
  blockedStep: number;
  blockedStepName: string;
  explanation: string;
  instructions: string[];
  onClose: () => void;
  onReview: () => void;
  onResolved: () => void;
}

export default function InterventionModal({
  runId,
  runName,
  blockedStep,
  blockedStepName,
  explanation,
  instructions,
  onClose,
  onReview,
  onResolved,
}: InterventionModalProps) {
  const { request } = useApi();
  const [resuming, setResuming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleContinue = async () => {
    setResuming(true);
    setError(null);
    try {
      await request("POST", `/runs/${runId}/resume`);
      logger.info("InterventionModal", "resume_run", { run_id: runId, status: "success" });
      onResolved();
    } catch (err) {
      logger.error("InterventionModal", "resume_run_failed", { run_id: runId }, err instanceof Error ? err : undefined);
      setError(err instanceof Error ? err.message : "Failed to resume");
    }
    setResuming(false);
  };

  const handleCancel = async () => {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setCancelling(true);
    setError(null);
    try {
      await request("POST", `/runs/${runId}/cancel`);
      logger.info("InterventionModal", "cancel_run", { run_id: runId, status: "success" });
      onResolved();
    } catch (err) {
      logger.error("InterventionModal", "cancel_run_failed", { run_id: runId }, err instanceof Error ? err : undefined);
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
    setCancelling(false);
    setConfirmCancel(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Workflow paused — action required"
    >
      <div className="bg-[#1A1D27] border border-[#2D3148] rounded-lg w-full max-w-[520px] mx-4 shadow-lg">
        <div className="flex items-start justify-between p-6 pb-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[rgba(253,203,110,0.15)] flex items-center justify-center flex-shrink-0">
              <AlertTriangle size={20} color="#FDCB6E" />
            </div>
            <div>
              <h2 className="text-[#E8EAED] font-semibold text-base">
                Workflow Paused — Action Required
              </h2>
              <p className="text-[#9AA0B0] text-xs mt-0.5">
                {runName && `${runName} · `}#{runId.slice(0, 8)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[#6B7280] hover:text-[#E8EAED] transition-colors"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6">
          <div className="text-[#9AA0B0] text-xs mb-3">
            Blocked at: Step {blockedStep} — <span className="text-[#E8EAED]">{blockedStepName}</span>
          </div>

          <p className="text-[#E8EAED] text-sm mb-4">{explanation}</p>

          <div className="bg-[#242836] rounded-md p-4 mb-4">
            <p className="text-[#FDCB6E] text-xs font-medium mb-2">What you need to do:</p>
            <ol className="space-y-1.5">
              {instructions.map((instruction, i) => (
                <li key={i} className="text-[#E8EAED] text-sm flex gap-2">
                  <span className="text-[#6B7280] flex-shrink-0">{i + 1}.</span>
                  <span>{instruction}</span>
                </li>
              ))}
            </ol>
          </div>

          <p className="text-[#00B894] text-xs font-medium flex items-center gap-1.5 mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#00B894]" />
            State is preserved — no data will be lost.
          </p>

          {error && (
            <div className="bg-[rgba(225,112,85,0.15)] border border-[rgba(225,112,85,0.3)] rounded-md px-3 py-2 mb-4">
              <p className="text-[#E17055] text-xs">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleContinue}
              disabled={resuming}
              className="flex-1 px-4 py-2.5 bg-[#6C5CE7] text-white text-sm font-medium rounded-md hover:bg-[#7C6EF7] transition-colors disabled:opacity-50"
            >
              {resuming ? "Resuming..." : "Continue Workflow"}
            </button>
            <button
              onClick={onReview}
              className="px-4 py-2.5 text-[#9AA0B0] text-sm rounded-md border border-[#2D3148] hover:text-[#E8EAED] hover:border-[#3D4160] transition-colors"
            >
              Review Details
            </button>
            <button
              onClick={handleCancel}
              disabled={cancelling}
              className={`px-4 py-2.5 text-sm rounded-md border transition-colors disabled:opacity-50 ${
                confirmCancel
                  ? "bg-[#E17055] text-white border-[#E17055]"
                  : "text-[#6B7280] border-[#2D3148] hover:text-[#E17055] hover:border-[#E17055]"
              }`}
            >
              {cancelling ? "Cancelling..." : confirmCancel ? "Confirm Cancel" : "Cancel Run"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
