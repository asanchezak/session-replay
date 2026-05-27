import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../hooks/useApi";

interface DaemonWorkerStatus {
  worker_id: string;
  polling: boolean;
  driving_run_id: string | null;
  last_seen: string;
  age_seconds: number;
  up: boolean;
}

interface DaemonStatusResponse {
  workers: DaemonWorkerStatus[];
  any_up: boolean;
}

function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${Math.round(ageSeconds)}s ago`;
  const minutes = Math.round(ageSeconds / 60);
  return `${minutes}m ago`;
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
        if (!cancelled) setStatus({ workers: [], any_up: false });
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
