import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

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
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch(`/v1/audit/${id}`);
        if (resp.ok) {
          const data = await resp.json();
          setEvents(data.events || []);
        }
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  if (loading) return <div data-testid="trace-loading">Loading...</div>;

  if (events.length === 0) {
    return (
      <div data-testid="trace-empty" className="p-8 text-center text-secondary">
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
          <div key={evt.id} className="flex items-center gap-4 p-2 bg-surface rounded-md text-sm font-mono">
            <span className="text-muted w-16 shrink-0">{evt.event_type}</span>
            <span className="text-muted w-12">{evt.actor_type}</span>
            <span className="text-muted truncate w-20">{evt.hash.slice(0, 8)}</span>
            <span className="text-secondary truncate">
              {evt.created_at}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
