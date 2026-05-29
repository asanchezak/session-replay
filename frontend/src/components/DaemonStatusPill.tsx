import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";

interface DaemonWorkerStatus {
  worker_id: string;
  polling: boolean;
  driving_run_id: string | null;
  circuit_open?: boolean | null;
  circuit_reason?: string | null;
  cooldown_until?: string | null;
  last_seen: string;
  age_seconds: number;
  up: boolean;
}

interface DaemonStatusResponse {
  workers: DaemonWorkerStatus[];
  any_up: boolean;
  circuit_open?: boolean;
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  const minutes = Math.round(ageSeconds / 60);
  return `${minutes}m ago`;
}

function formatUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const until = Date.parse(iso);
  if (!Number.isFinite(until)) return "";
  const mins = Math.round((until - Date.now()) / 60000);
  if (mins <= 0) return "";
  if (mins < 60) return ` · ~${mins}m left`;
  return ` · ~${Math.round(mins / 60)}h left`;
}

export default function DaemonStatusPill() {
  const { request } = useApi();
  const [status, setStatus] = useState<DaemonStatusResponse>({ workers: [], any_up: false });

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await request<DaemonStatusResponse>("GET", "/daemon/status");
        if (!cancelled) setStatus(next);
      } catch {
        // Preserve the last known daemon state on transient fetch failures.
      }
    };

    void load();
    const interval = setInterval(() => {
      void load();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [request]);

  const mostRecentWorker = status.workers[0] || null;
  const activeWorker = status.workers.find((worker) => worker.up && worker.driving_run_id) || null;
  const cooldownWorker = status.workers.find((worker) => worker.up && worker.circuit_open) || null;

  // Circuit breaker open = the LinkedIn account is in cooldown; the daemon won't
  // drive until it clears. Surface this so operators don't wonder why a trigger
  // does nothing. Takes priority over the plain "up" state (a driving run can't
  // coexist with an open circuit, so this sits after the driving-run check).
  if (cooldownWorker) {
    const reason = cooldownWorker.circuit_reason ? ` (${cooldownWorker.circuit_reason})` : "";
    return (
      <div
        className="flex items-center gap-2 text-xs text-[#FF7675]"
        aria-label="LinkedIn account in cooldown"
        title={`Circuit breaker open${reason}${formatUntil(cooldownWorker.cooldown_until)}`}
      >
        <span className="w-2 h-2 rounded-full bg-[#FF7675]" />
        <span>Account cooldown{reason}{formatUntil(cooldownWorker.cooldown_until)}</span>
      </div>
    );
  }

  if (activeWorker?.driving_run_id) {
    return (
      <Link
        to={`/runs/${activeWorker.driving_run_id}`}
        className="flex items-center gap-2 text-xs text-[#E8EAED] hover:text-[#FDCB6E] transition-colors"
        aria-label="Daemon driving an active run"
      >
        <span className="w-2 h-2 rounded-full bg-[#FDCB6E] animate-pulse" />
        <span>Daemon driving run</span>
      </Link>
    );
  }

  if (status.any_up) {
    return (
      <div className="flex items-center gap-2 text-xs text-[#9AA0B0]" aria-label="Daemon is up">
        <span className="w-2 h-2 rounded-full bg-[#00B894]" />
        <span>Daemon up</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs text-[#9AA0B0]" aria-label="Daemon is down">
      <span className="w-2 h-2 rounded-full bg-[#FF7675]" />
      <span>
        {mostRecentWorker ? `Daemon down · last seen ${formatAge(mostRecentWorker.age_seconds)}` : "Daemon down"}
      </span>
    </div>
  );
}
