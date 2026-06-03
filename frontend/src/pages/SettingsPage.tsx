import { useEffect, useState } from "react";
import Card from "../components/Card";
import Banner from "../components/Banner";
import { Settings, Key, Bell, Users, Clock, Shield } from "lucide-react";
import { useApi } from "../hooks/useApi";

interface SettingRowProps {
  label: string;
  description: string;
  children: React.ReactNode;
}

function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between py-4 border-b border-[#2D3148] last:border-0">
      <div className="flex-1 mr-8">
        <div className="text-sm text-[#E8EAED] font-medium">{label}</div>
        <div className="text-xs text-[#9AA0B0] mt-1">{description}</div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const [aiThreshold, setAiThreshold] = useState(85);
  const [autoRetry, setAutoRetry] = useState(3);
  const [retentionDays, setRetentionDays] = useState(90);
  const [deterministic, setDeterministic] = useState(false);
  const [apiKey, setApiKey] = useState("sk-••••••••••••••••");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { request } = useApi();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await request<{ settings: Record<string, unknown> }>("GET", "/settings");
        if (!cancelled && data.settings) {
          if (typeof data.settings.ai_confidence_threshold === "number") {
            setAiThreshold(Math.round(data.settings.ai_confidence_threshold * 100));
          }
          if (typeof data.settings.auto_retry_limit === "number") {
            setAutoRetry(data.settings.auto_retry_limit);
          }
          if (typeof data.settings.retention_days === "number") {
            setRetentionDays(data.settings.retention_days);
          }
          if (typeof data.settings.deterministic_only === "boolean") {
            setDeterministic(data.settings.deterministic_only);
          }
        }
      } catch {
        // use defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [request]);

  const handleSave = async () => {
    setError(null);
    setSaved(false);
    try {
      await request("PUT", "/settings", {
        ai_confidence_threshold: aiThreshold / 100,
        auto_retry_limit: autoRetry,
        retention_days: retentionDays,
        deterministic_only: deterministic,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings");
    }
  };

  const handleRevoke = () => {
    setApiKey("sk-" + Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join(""));
  };

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4 text-[#E8EAED] flex items-center gap-2">
        <Settings size={20} /> Settings
      </h1>

      {loading && (
        <div className="mb-4 text-[#9AA0B0] text-sm">Loading settings…</div>
      )}

      {saved && (
        <div className="mb-4">
          <Banner type="success" title="Settings saved">
            Configuration updated successfully.
          </Banner>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <Banner type="error" title="Failed to save settings">
            {error}
          </Banner>
        </div>
      )}

      <div className="space-y-4">
        {/* Policies */}
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-2 flex items-center gap-2">
            <Shield size={14} /> Policies
          </h2>
          <SettingRow
            label="AI Confidence Threshold"
            description="Minimum confidence score for automatic recovery (0-100%)"
          >
            <div className="flex items-center gap-2">
              <input
                type="range"
                min="0" max="100" step="5"
                value={aiThreshold}
                onChange={(e) => setAiThreshold(Number(e.target.value))}
                className="w-24"
              />
              <span className="text-sm text-[#E8EAED] min-w-[3ch]">{aiThreshold}%</span>
            </div>
          </SettingRow>
          <SettingRow
            label="Auto-Retry Limit"
            description="Maximum number of retry attempts for failed steps"
          >
            <select
              value={autoRetry}
              onChange={(e) => setAutoRetry(Number(e.target.value))}
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-1.5 text-sm"
            >
              {[0, 1, 2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>{n === 0 ? "No retries" : `${n} retries`}</option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            label="Modo determinístico (sin IA)"
            description="Cuando está ON, los runs se ejecutan sin IA por paso ni recuperación por IA: si un selector falla, el run pausa para un humano en vez de gastar el budget de IA. (No afecta al daemon de LinkedIn.)"
          >
            <button
              type="button"
              role="switch"
              aria-checked={deterministic}
              onClick={() => setDeterministic((v) => !v)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                deterministic ? "bg-accent" : "bg-[#2D3148]"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  deterministic ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </SettingRow>
        </Card>

        {/* Retention */}
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-2 flex items-center gap-2">
            <Clock size={14} /> Retention
          </h2>
          <SettingRow
            label="Log Retention Period"
            description="How long to keep audit logs and event data"
          >
            <select
              value={retentionDays}
              onChange={(e) => setRetentionDays(Number(e.target.value))}
              className="bg-[#2A2E3D] text-[#E8EAED] border border-[#2D3148] rounded-md px-3 py-1.5 text-sm"
            >
              {[7, 14, 30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </SettingRow>
        </Card>

        {/* API Keys */}
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-2 flex items-center gap-2">
            <Key size={14} /> API Keys
          </h2>
          <SettingRow
            label="Extension API Key"
            description="Used by the browser extension to authenticate with the backend"
          >
            <div className="flex items-center gap-2">
              <code className="bg-[#2A2E3D] px-3 py-1.5 rounded-md text-xs font-mono text-[#9AA0B0]">
                {showKey ? apiKey : apiKey.slice(0, 8) + "••••••••••••••••"}
              </code>
              <button
                onClick={() => setShowKey(!showKey)}
                className="text-xs text-[#6C5CE7] hover:text-[#7C6EF7]"
              >
                {showKey ? "Hide" : "Show"}
              </button>
              <button onClick={handleRevoke} className="text-xs text-[#E17055] hover:text-[#FF8A76]">
                Revoke
              </button>
            </div>
          </SettingRow>
        </Card>

        {/* Team */}
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-2 flex items-center gap-2">
            <Users size={14} /> Team
          </h2>
          <div className="text-[#9AA0B0] text-sm py-2">
            Team management is configured via the backend admin interface.
          </div>
        </Card>

        {/* Notifications */}
        <Card>
          <h2 className="text-sm font-medium text-[#E8EAED] mb-2 flex items-center gap-2">
            <Bell size={14} /> Notifications
          </h2>
          <div className="text-[#9AA0B0] text-sm py-2">
            Email and Slack/webhook alerts for workflow failures and human interventions.
            Configure in <code className="text-[#6C5CE7]">backend/.env</code>.
          </div>
        </Card>
      </div>

      <div className="mt-6 flex justify-end">
        <button
          onClick={handleSave}
          className="px-6 py-2 bg-[#6C5CE7] text-white text-sm rounded-md hover:bg-[#7C6EF7] transition-colors"
        >
          Save All Settings
        </button>
      </div>
    </div>
  );
}
