import { useEffect, useState } from "react";
import { useApi } from "../hooks/useApi";

interface ArtifactMeta {
  id: string;
  step_index: number | null;
  artifact_type: string;
  mime_type: string;
  created_at: string;
  metadata?: { original_filename?: string };
}

// Gallery of screenshots stored as artifacts for a run (or, with
// artifactType="recording_capture" + the workflow id, the captures taken while
// a workflow was recorded — run_id has no FK so recordings reuse the same
// pipeline). Images are gated by the API key, so we fetch them as object URLs.
export default function StepScreenshots({
  runId,
  artifactType = "page_capture",
}: { runId: string; artifactType?: string }) {
  const { request, requestBlobUrl } = useApi();
  const [shots, setShots] = useState<ArtifactMeta[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    (async () => {
      setLoading(true);
      try {
        const all = await request<ArtifactMeta[]>("GET", `/runs/${runId}/artifacts`);
        const caps = all
          .filter((a) => a.artifact_type === artifactType && a.mime_type.startsWith("image/"))
          .sort((a, b) => (a.step_index ?? 0) - (b.step_index ?? 0));
        if (cancelled) return;
        setShots(caps);
        for (const a of caps) {
          try {
            const u = await requestBlobUrl(`/artifacts/${a.id}`);
            if (cancelled) { URL.revokeObjectURL(u); return; }
            created.push(u);
            setUrls((m) => ({ ...m, [a.id]: u }));
          } catch { /* skip a broken image */ }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; created.forEach((u) => URL.revokeObjectURL(u)); };
  }, [runId, artifactType, request, requestBlobUrl]);

  const label = (a: ArtifactMeta) =>
    a.metadata?.original_filename?.replace(/\.png$/i, "") || `step ${a.step_index ?? "?"}`;

  if (loading && shots.length === 0) {
    return <p className="text-text-gray text-sm p-2">Cargando capturas…</p>;
  }
  if (shots.length === 0) {
    return <p className="text-text-gray text-sm p-2">Sin capturas todavía.</p>;
  }

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {shots.map((a) => (
          <button
            key={a.id}
            onClick={() => urls[a.id] && setZoom(urls[a.id])}
            className="text-left bg-bg-card border border-border rounded-md overflow-hidden hover:border-accent transition-colors"
          >
            {urls[a.id] ? (
              <img
                src={urls[a.id]}
                alt={label(a)}
                className="w-full h-40 object-cover object-top bg-bg-surface"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-40 bg-bg-surface animate-pulse" />
            )}
            <div className="px-2 py-1.5 text-xs font-mono text-text-secondary truncate" title={label(a)}>
              {label(a)}
            </div>
          </button>
        ))}
      </div>

      {zoom && (
        <div
          className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-6 cursor-zoom-out"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="captura" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  );
}
