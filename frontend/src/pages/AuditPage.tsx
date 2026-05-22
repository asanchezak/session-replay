import { Fragment, useState, useEffect } from "react";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import Banner from "../components/Banner";
import { useApiData } from "../hooks/useApi";
import { formatTime } from "../lib/formatTime";
import { ScrollText, Search, ShieldCheck, ShieldAlert } from "lucide-react";

interface AuditEvent {
  id: string;
  event_type: string;
  actor_type: string;
  payload: Record<string, unknown>;
  page_url?: string;
  hash: string;
  previous_hash: string;
  created_at: string;
}

interface AuditData {
  run_id: string;
  workflow_id: string;
  event_count: number;
  chain_valid: boolean;
  broken_links: Array<{ event_id: string; index: number; expected: string; actual: string }>;
  events: AuditEvent[];
}

interface Run {
  id: string;
  workflow_id: string;
  status: string;
  current_step_index: number;
  total_steps: number;
  created_at: string;
}

export default function AuditPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  const runsState = useApiData<Run[]>();
  const auditState = useApiData<AuditData>();

  useEffect(() => {
    runsState.fetchData("GET", "/runs");
  }, []);

  useEffect(() => {
    if (selectedRunId) {
      const filterParam = filter ? `?filter=${encodeURIComponent(filter)}` : "";
      auditState.fetchData("GET", `/audit/${selectedRunId}${filterParam}`);
    }
  }, [selectedRunId, filter]);

  const runs = runsState.data || [];
  const audit = auditState.data;
  const filteredEvents = audit?.events.filter((e) =>
    !filter || e.event_type.includes(filter) || e.actor_type.includes(filter)
  ) || [];
  const eventTypes = [...new Set(audit?.events.map((e) => e.event_type) || [])];

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4 text-text-primary flex items-center gap-2">
        <ScrollText size={20} /> Audit Trail
      </h1>

      {/* Run selector */}
      <div className="mb-4">
        <label className="text-text-secondary text-xs mb-1 block">Select a run to inspect</label>
        <select
          value={selectedRunId || ""}
          onChange={(e) => setSelectedRunId(e.target.value || null)}
          className="bg-bg-input text-text-primary border border-border rounded-md px-3 py-2 text-sm w-80"
        >
          <option value="">— Select a run —</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              #{r.id.slice(0, 8)} — {r.status} ({formatTime(r.created_at)})
            </option>
          ))}
        </select>
      </div>

      {auditState.loading && (
        <div className="text-text-secondary text-sm">Loading audit trail...</div>
      )}

      {auditState.error && (
        <Banner type="error" title="Failed to load audit trail">
          {auditState.error}
        </Banner>
      )}

      {!selectedRunId && !auditState.loading && (
        <EmptyState
          icon={<ScrollText size={32} />}
          title="No audit events"
          description="Run a workflow and select it above to inspect its audit trail."
        />
      )}

      {audit && (
        <>
          {/* Chain health banner */}
          <div className="mb-4">
            <Banner
              type={audit.chain_valid ? "success" : "error"}
              title={audit.chain_valid ? "Hash Chain Valid" : "Hash Chain COMPROMISED"}
            >
              {audit.chain_valid
                ? `${audit.event_count} events, 0 broken links. Tamper evidence intact.`
                : `${audit.broken_links.length} broken link(s) detected! Data integrity compromised.`
              }
            </Banner>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2 bg-bg-input rounded-md px-3 py-2 text-sm">
              <Search size={14} className="text-text-secondary" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="bg-transparent text-text-primary border-none outline-none text-sm"
              >
                <option value="">All event types</option>
                {eventTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <span className="text-text-secondary text-xs">
              {filteredEvents.length} of {audit.events.length} events
            </span>
          </div>

          {/* Event table */}
          <Card padding="sm">
            <table className="w-full text-sm" role="table">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Time</th>
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Event</th>
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Actor</th>
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Payload</th>
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Hash</th>
                  <th className="text-left text-text-secondary font-normal text-xs py-3 px-3">Prev Hash</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((ev) => (
                  <Fragment key={ev.id}>
                    <tr
                      onClick={() => setExpandedEvent(expandedEvent === ev.id ? null : ev.id)}
                      className="border-b border-border hover:bg-bg-elevated transition-colors cursor-pointer"
                    >
                      <td className="py-2 px-3 text-text-gray text-xs font-mono">
                        {formatTime(ev.created_at)}
                      </td>
                      <td className="py-2 px-3">
                        <span className="text-xs font-mono text-info">{ev.event_type}</span>
                      </td>
                      <td className="py-2 px-3 text-text-secondary text-xs">{ev.actor_type}</td>
                      <td className="py-2 px-3 text-text-secondary text-xs max-w-[200px] truncate font-mono">
                        {JSON.stringify(ev.payload).slice(0, 60)}
                      </td>
                      <td className="py-2 px-3">
                        <span className="text-xs font-mono text-text-gray" title={ev.hash}>
                          {ev.hash.slice(0, 12)}…
                        </span>
                      </td>
                      <td className="py-2 px-3">
                        <span className="text-xs font-mono text-text-gray" title={ev.previous_hash}>
                          {ev.previous_hash.slice(0, 12)}…
                        </span>
                      </td>
                    </tr>
                    {expandedEvent === ev.id && (
                      <tr key={`${ev.id}-expanded`}>
                        <td colSpan={6} className="bg-bg-elevated px-6 py-4">
                          <div className="text-xs font-mono text-text-primary whitespace-pre-wrap">
                            <div className="mb-2"><span className="text-text-secondary">Full hash:</span> {ev.hash}</div>
                            <div className="mb-2"><span className="text-text-secondary">Previous hash:</span> {ev.previous_hash}</div>
                            {ev.page_url && <div className="mb-2"><span className="text-text-secondary">Page URL:</span> {ev.page_url}</div>}
                            <div><span className="text-text-secondary">Payload:</span> {JSON.stringify(ev.payload, null, 2)}</div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {filteredEvents.length === 0 && (
              <div className="py-8 text-center text-text-secondary text-sm">
                No events match the current filter.
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
