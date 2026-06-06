import { useEffect, useState } from "react";
import Card from "../components/Card";
import EmptyState from "../components/EmptyState";
import Banner from "../components/Banner";
import { useApiData } from "../hooks/useApi";
import { useApi } from "../hooks/useApi";
import { Cable, Plus, CheckCircle, XCircle, RefreshCw, Zap } from "lucide-react";

interface WebhookTrigger {
  id: string;
  connector_id: string;
  workflow_id: string;
  event_kind: string;
  enabled: boolean;
}

interface Connector {
  id: string;
  name: string;
  type: string;
  status: string;
  last_sync?: string;
}

interface OdooConfigDraft {
  name: string;
  url: string;
  database: string;
  username: string;
  password: string;
}

function triggerEventLabel(value: string): string {
  if (value === "linkedin_lead_search") return "Lead sourcing";
  if (value === "new_job_position") return "Applicant scraping";
  return value;
}

export default function ConnectorsPage() {
  const { data: connectors, loading, error, fetchData } = useApiData<Connector[]>();
  const { request } = useApi();
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; status: string; message?: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState("odoo");
  const [newName, setNewName] = useState("");
  const [newConfig, setNewConfig] = useState<Omit<OdooConfigDraft, "name">>({
    url: "",
    database: "",
    username: "",
    password: "",
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const [configDraft, setConfigDraft] = useState<OdooConfigDraft | null>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [connectorTriggers, setConnectorTriggers] = useState<Record<string, WebhookTrigger[]>>({});

  useEffect(() => {
    fetchData("GET", "/connectors");
  }, [fetchData]);

  const handleTest = async (connectorId: string) => {
    setTesting(connectorId);
    setTestResult(null);
    try {
      const result = await request<{ status: string; message?: string }>("POST", `/connectors/${connectorId}/test`);
      setTestResult({ id: connectorId, ...result });
      fetchData("GET", "/connectors");
    } catch (err) {
      setTestResult({ id: connectorId, status: "error", message: err instanceof Error ? err.message : "Test failed" });
    }
    setTesting(null);
  };

  const handleConfigure = async (connectorId: string) => {
    if (configuringId === connectorId) {
      setConfiguringId(null);
      setConfigDraft(null);
      setConfigError(null);
      return;
    }
    try {
      const detail = await request<{ name: string; config: Record<string, string> }>("GET", `/connectors/${connectorId}`);
      const loadedPassword = detail.config.password === "[REDACTED]" ? "" : (detail.config.password || "");
      setConfigDraft({
        name: detail.name,
        url: detail.config.url || "",
        database: detail.config.database || "",
        username: detail.config.username || "",
        password: loadedPassword,
      });
      setConfiguringId(connectorId);
      setConfigError(null);
      // Fetch webhook triggers for this connector
      request<{ triggers: WebhookTrigger[] }>("GET", `/connectors/${connectorId}/webhook-triggers`)
        .then((res) => setConnectorTriggers((prev) => ({ ...prev, [connectorId]: res.triggers })))
        .catch(() => {});
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Failed to load connector config");
    }
  };

  const handleConfigSave = async (connectorId: string) => {
    if (!configDraft) return;
    setConfigSaving(true);
    setConfigError(null);
    try {
      const configPayload: Record<string, string> = {
        url: configDraft.url,
        database: configDraft.database,
        username: configDraft.username,
      };
      if (configDraft.password.trim()) {
        configPayload.password = configDraft.password;
      }
      await request("PUT", `/connectors/${connectorId}`, {
        name: configDraft.name,
        config: configPayload,
      });
      setConfiguringId(null);
      setConfigDraft(null);
      fetchData("GET", "/connectors");
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "Failed to save");
    }
    setConfigSaving(false);
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    if (newType === "odoo" && (!newConfig.url || !newConfig.database || !newConfig.username)) {
      setSaveError("Odoo connectors require URL, database, and username.");
      return;
    }
    try {
      const config = newType === "odoo"
        ? { url: newConfig.url, database: newConfig.database, username: newConfig.username, password: newConfig.password }
        : {};
      await request("POST", "/connectors", { type: newType, name: newName, config });
      setShowAdd(false);
      setNewName("");
      setNewConfig({ url: "", database: "", username: "", password: "" });
      setSaveError(null);
      fetchData("GET", "/connectors");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to add connector");
    }
  };

  const list = connectors || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-[#E8EAED] flex items-center gap-2">
          <Cable size={20} /> Connectors
        </h1>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors"
        >
          <Plus size={14} /> Add Connector
        </button>
      </div>

      {error && (
        <Banner type="error" title="Failed to load connectors">{error}</Banner>
      )}

      {showAdd && (
        <Card className="mb-4">
          <h3 className="text-sm font-medium text-[#E8EAED] mb-3">New Connector</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Connector name"
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm"
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm"
            >
              <option value="odoo">Odoo</option>
            </select>
            {newType === "odoo" && (
              <>
                <input value={newConfig.url} onChange={(e) => setNewConfig((p) => ({ ...p, url: e.target.value }))} placeholder="https://odoo.example.com" className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                <input value={newConfig.database} onChange={(e) => setNewConfig((p) => ({ ...p, database: e.target.value }))} placeholder="Database" className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                <input value={newConfig.username} onChange={(e) => setNewConfig((p) => ({ ...p, username: e.target.value }))} placeholder="Username" className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                <input type="password" value={newConfig.password} onChange={(e) => setNewConfig((p) => ({ ...p, password: e.target.value }))} placeholder="Password" className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
              </>
            )}
          </div>
          {saveError && <div className="mt-3 text-xs text-[#E17055]">{saveError}</div>}
          <div className="mt-3">
            <button onClick={handleAdd} className="px-4 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors">Save</button>
          </div>
        </Card>
      )}

      {loading ? (
        <div className="text-[#9AA0B0] text-sm">Loading...</div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Cable size={32} />}
          title="No connectors configured"
          description="Connect a system to enable sync. Odoo is supported out of the box."
          actions={
            <button onClick={() => setShowAdd(true)} className="px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors">
              Add Connector
            </button>
          }
        />
      ) : (
        <div className="grid gap-4">
          {list.map((conn) => {
            const isConnected = conn.status === "connected" || conn.status === "ok";
            const isConfiguring = configuringId === conn.id;
            return (
              <Card key={conn.id}>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {isConnected ? (
                      <CheckCircle size={20} className="text-[#00B894]" />
                    ) : (
                      <XCircle size={20} className="text-[#E17055]" />
                    )}
                    <div>
                      <h3 className="text-sm font-medium text-[#E8EAED]">{conn.name}</h3>
                      <p className="text-[#9AA0B0] text-xs">Type: {conn.type} · {isConnected ? "Connected" : "Not connected"}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(conn.id)}
                      disabled={testing === conn.id}
                      className="flex items-center gap-1 px-3 py-1.5 bg-[#242836] text-[#E8EAED] text-xs rounded-md hover:bg-[#2A2E3D] transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={testing === conn.id ? "animate-spin" : ""} />
                      Test
                    </button>
                    <button
                      onClick={() => handleConfigure(conn.id)}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${isConfiguring ? "bg-accent text-white" : "bg-[#242836] text-[#E8EAED] hover:bg-[#2A2E3D]"}`}
                    >
                      {isConfiguring ? "Close" : "Configure"}
                    </button>
                  </div>
                </div>

                {testResult && testResult.id === conn.id && (
                  <div className={`mt-3 text-xs ${testResult.status === "ok" ? "text-[#00B894]" : "text-[#E17055]"}`}>
                    {testResult.status === "ok" ? "✓ Connected successfully" : `✗ ${testResult.message || "Connection failed"}`}
                  </div>
                )}

                {isConfiguring && configDraft && (
                  <div className="mt-4 pt-4 border-t border-border space-y-3">
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <label className="block text-xs text-text-secondary mb-1">Name</label>
                        <input value={configDraft.name} onChange={(e) => setConfigDraft((p) => p ? { ...p, name: e.target.value } : p)} className="w-full bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">URL</label>
                        <input value={configDraft.url} onChange={(e) => setConfigDraft((p) => p ? { ...p, url: e.target.value } : p)} className="w-full bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">Database</label>
                        <input value={configDraft.database} onChange={(e) => setConfigDraft((p) => p ? { ...p, database: e.target.value } : p)} className="w-full bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">Username</label>
                        <input value={configDraft.username} onChange={(e) => setConfigDraft((p) => p ? { ...p, username: e.target.value } : p)} className="w-full bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs text-text-secondary mb-1">Password</label>
                        <input type="password" value={configDraft.password} onChange={(e) => setConfigDraft((p) => p ? { ...p, password: e.target.value } : p)} className="w-full bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm" />
                        <p className="mt-1 text-[11px] text-text-secondary">Leave blank to keep the stored password.</p>
                      </div>
                    </div>
                    {configError && <div className="text-xs text-[#E17055]">{configError}</div>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleConfigSave(conn.id)}
                        disabled={configSaving}
                        className="px-3 py-1.5 bg-[#6C5CE7] text-white text-xs rounded-md hover:bg-[#7C6EF7] disabled:opacity-50 transition-colors"
                      >
                        {configSaving ? "Saving…" : "Save"}
                      </button>
                      <button
                        onClick={() => { setConfiguringId(null); setConfigDraft(null); setConfigError(null); }}
                        className="px-3 py-1.5 bg-[#242836] text-[#E8EAED] text-xs rounded-md hover:bg-[#2A2E3D] transition-colors"
                      >
                        Cancel
                      </button>
                    </div>

                    {/* Webhook Triggers for this connector */}
                    <div className="pt-3 border-t border-border">
                      <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-2 flex items-center gap-1.5">
                        <Zap size={11} /> Workflow Triggers
                      </h4>
                      {(connectorTriggers[conn.id] || []).length === 0 ? (
                        <p className="text-xs text-text-gray italic">No workflows triggered by this connector. Link one from a workflow's Automation Triggers section.</p>
                      ) : (
                        <div className="space-y-1">
                          {(connectorTriggers[conn.id] || []).map((t) => (
                            <div key={t.id} className="flex items-center gap-2 text-xs">
                              <span className={`w-1.5 h-1.5 rounded-full ${t.enabled ? "bg-success" : "bg-text-gray"}`} />
                              <span className="text-text-secondary font-mono">{t.workflow_id.slice(0, 8)}…</span>
                              <span className="text-info">{triggerEventLabel(t.event_kind)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {conn.last_sync && (
                  <div className="mt-2 text-[#6B7280] text-xs">Last sync: {conn.last_sync}</div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
