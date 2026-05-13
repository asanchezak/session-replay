import { useEffect, useState } from "react";
import Card from "../components/Card";
import EmptyState from "../components/EmptyState";
import Banner from "../components/Banner";
import { useApiData } from "../hooks/useApi";
import { useApi } from "../hooks/useApi";
import { Cable, Plus, CheckCircle, XCircle, RefreshCw } from "lucide-react";

interface Connector {
  id: string;
  name: string;
  type: string;
  status: string;
  last_sync?: string;
}

export default function ConnectorsPage() {
  const { data: connectors, loading, error, fetchData } = useApiData<Connector[]>();
  const { request } = useApi();
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; status: string; message?: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newType, setNewType] = useState("odoo");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    fetchData("GET", "/connectors");
  }, []);

  const handleTest = async (connectorId: string) => {
    setTesting(connectorId);
    try {
      const result = await request<{ status: string; message?: string }>("POST", `/connectors/${connectorId}/test`);
      setTestResult({ id: connectorId, ...result });
    } catch (err) {
      setTestResult({ id: connectorId, status: "error", message: err instanceof Error ? err.message : "Test failed" });
    }
    setTesting(null);
  };

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await request("POST", "/connectors", { type: newType, name: newName, config: {} });
      setShowAdd(false);
      setNewName("");
      fetchData("GET", "/connectors");
    } catch (err) {
      console.error("Failed to add connector:", err);
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
          <div className="flex items-center gap-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Connector name"
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm flex-1"
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-2 text-sm"
            >
              <option value="odoo">Odoo</option>
              <option value="salesforce">Salesforce</option>
              <option value="hubspot">HubSpot</option>
              <option value="custom">Custom API</option>
            </select>
            <button
              onClick={handleAdd}
              className="px-4 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors"
            >
              Save
            </button>
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
            <button
              onClick={() => setShowAdd(true)}
              className="px-3 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors"
            >
              Add Connector
            </button>
          }
        />
      ) : (
        <div className="grid gap-4">
          {list.map((conn) => (
            <Card key={conn.id}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {conn.status === "connected" || conn.status === "ok" ? (
                    <CheckCircle size={20} className="text-[#00B894]" />
                  ) : (
                    <XCircle size={20} className="text-[#E17055]" />
                  )}
                  <div>
                    <h3 className="text-sm font-medium text-[#E8EAED]">{conn.name}</h3>
                    <p className="text-[#9AA0B0] text-xs">Type: {conn.type}</p>
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
                  <button className="px-3 py-1.5 bg-[#242836] text-[#E8EAED] text-xs rounded-md hover:bg-[#2A2E3D] transition-colors">
                    Configure
                  </button>
                  <button className="px-3 py-1.5 bg-[#242836] text-[#E8EAED] text-xs rounded-md hover:bg-[#2A2E3D] transition-colors">
                    View Logs
                  </button>
                </div>
              </div>
              {testResult && testResult.id === conn.id && (
                <div className={`mt-3 text-xs ${testResult.status === "ok" ? "text-[#00B894]" : "text-[#E17055]"}`}>
                  {testResult.status === "ok" ? "✓ Connected successfully" : `✗ ${testResult.message || "Connection failed"}`}
                </div>
              )}
              {conn.last_sync && (
                <div className="mt-2 text-[#6B7280] text-xs">Last sync: {conn.last_sync}</div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
