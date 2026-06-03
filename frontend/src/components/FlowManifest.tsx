import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useApi } from "../hooks/useApi";

interface ManifestStep { index: number; action: string; label: string; desc: string; }
interface Manifest { flow: string; job_title?: string; hardcoded?: boolean; steps: ManifestStep[]; }
interface ArtifactMeta { id: string; artifact_type: string; }

// Renders the daemon's hardcoded-flow manifest (uploaded as a flow_manifest
// artifact at run start). The preamble flow is hardcoded, not a recorded
// workflow, so this is the only way to see what the daemon does at each step.
// Step indices/labels match the per-step screenshots.
export default function FlowManifest({ runId }: { runId: string }) {
  const { request } = useApi();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await request<ArtifactMeta[]>("GET", `/runs/${runId}/artifacts`);
        const m = all.filter((a) => a.artifact_type === "flow_manifest").pop();
        if (!m || cancelled) return;
        const data = await request<Manifest>("GET", `/artifacts/${m.id}`);
        if (!cancelled) setManifest(data);
      } catch { /* no manifest (run not driven yet, or generic mode) */ }
    })();
    return () => { cancelled = true; };
  }, [runId, request]);

  if (!manifest) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-bg-card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left px-3 py-2 text-sm text-text-primary"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-medium">Flujo del daemon (hardcodeado)</span>
        <span className="text-xs text-text-gray font-mono">{manifest.flow}</span>
        <span className="ml-auto text-xs text-text-gray">{manifest.steps.length} pasos</span>
      </button>
      {open && (
        <ol className="border-t border-border divide-y divide-border">
          {manifest.steps.map((s) => (
            <li key={s.index} className="flex gap-3 px-3 py-2">
              <span className="text-xs font-mono text-accent shrink-0 w-6 text-right">{s.index}</span>
              <div className="min-w-0">
                <div className="text-xs">
                  <span className="font-mono text-text-secondary">{s.action}</span>
                  <span className="text-text-gray"> · {s.label}</span>
                </div>
                <p className="text-xs text-text-secondary mt-0.5">{s.desc}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
