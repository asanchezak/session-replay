import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useApi } from "../hooks/useApi";

interface TraceEvent {
  id: string;
  event_type: string;
  actor_type: string;
  payload: Record<string, unknown>;
  hash: string;
  previous_hash: string;
  created_at: string;
}

export default function TracePage() {
  const { id } = useParams<{ id: string }>();
  const { request } = useApi();
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const data = await request<{ events: TraceEvent[] }>("GET", `/audit/${id}`);
        setEvents(data.events || []);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, request]);

  if (loading) return <div data-testid="trace-loading">Loading...</div>;

  if (events.length === 0) {
    return (
      <div data-testid="trace-empty" className="p-8 text-center text-text-secondary">
        <p className="text-lg">No audit events</p>
        <p className="text-sm mt-2">Run a workflow to generate an audit trail.</p>
      </div>
    );
  }

  return (
    <div className="p-6" data-testid="trace-page">
      <h1 className="text-xl font-semibold mb-4">Audit Trail — Run {id}</h1>
      <div className="space-y-1">
        {events.map((evt) => (
          <div key={evt.id} className="flex items-center gap-4 p-2 bg-bg-surface rounded-md text-sm font-mono">
            <span className="text-text-muted w-16 shrink-0">{evt.event_type}</span>
            <span className="text-text-muted w-12">{evt.actor_type}</span>
            <span className="text-text-muted truncate w-20">{evt.hash.slice(0, 8)}</span>
            <span className="text-text-secondary truncate">
              {evt.created_at}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
