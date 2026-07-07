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
  // Recruiter /talent seat health from the daemon's last keepalive ping.
  // false = walled (needs re-login); true = warm; null/undefined = unknown.
  seat_warm?: boolean | null;
  seat_checked_at?: string | null;
  last_seen: string;
  age_seconds: number;
  up: boolean;
}

interface DaemonStatusResponse {
  workers: DaemonWorkerStatus[];
  any_up: boolean;
  circuit_open?: boolean;
  // Count of QUEUED runs that need the warm /talent seat — the backlog the daemon
  // holds while the seat is walled. Lets a held backlog read as waiting, not stuck.
  queued_seat_runs?: number;
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
  // A live daemon whose last keepalive ping found the /talent seat walled: recruiter
  // runs will fail until someone re-logs in (login-talent.bat). Surface it so it's
  // obvious without running a pre-flight against the sensitive account.
  const walledWorker = status.workers.find((worker) => worker.up && worker.seat_warm === false) || null;

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

  if (walledWorker) {
    // While walled, the daemon HOLDS seat-requiring runs in the queue (it no longer
    // drives them onto a cold seat) and drains them on re-login — so show the count
    // waiting, so a held backlog reads as "waiting", not "stuck".
    const waiting = status.queued_seat_runs ?? 0;
    return (
      <div
        className="flex items-center gap-2 text-xs text-[#FDCB6E]"
        aria-label="Recruiter seat walled"
        title={`/talent seat walled — re-login needed (login-talent.bat).${
          waiting > 0 ? ` ${waiting} run(s) queued, will run automatically once the seat is back.` : ""
        }${
          walledWorker.seat_checked_at ? ` · checked ${formatAge((Date.now() - Date.parse(walledWorker.seat_checked_at)) / 1000)}` : ""
        }`}
      >
        <span className="w-2 h-2 rounded-full bg-[#FDCB6E]" />
        <span>
          Seat walled · re-login{waiting > 0 ? ` · ${waiting} waiting` : ""}
        </span>
      </div>
    );
  }

  if (status.any_up) {
    return (
      <div className="flex items-center gap-2 text-xs text-[#9AA0B0]" aria-label="Daemon is up">
        <span className="w-2 h-2 rounded-full bg-[#00B894]" />
        <span>Daemon up{status.workers.some((w) => w.up && w.seat_warm === true) ? " · seat warm" : ""}</span>
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
