# Keep ONLY the newest N run-dirs under the recruiter-snapshots folder; delete older ones.
# The daemon writes per-run snapshots to recruiter-snapshots\<runId>\ (when snapshot:true),
# which accumulate forever. This prunes to the last N runs (by folder mtime ≈ run time).
# Registered as the `recruiter-snapshot-prune` scheduled task (timer) on Fernanda's host;
# can also be run on demand. Keep is overridable: -Keep 15 (default).
param(
    [int]$Keep = 15,
    [string]$Dir = "C:\Users\Public\extension\recruiter-snapshots"
)
$ErrorActionPreference = "SilentlyContinue"
if (-not (Test-Path $Dir)) { exit 0 }
$runs = Get-ChildItem -Path $Dir -Directory | Sort-Object LastWriteTime -Descending
if ($runs.Count -le $Keep) {
    Write-Output ("prune: {0} run-dir(s) <= keep {1}; nothing to delete" -f $runs.Count, $Keep)
    exit 0
}
$old = $runs | Select-Object -Skip $Keep
foreach ($r in $old) { Remove-Item -LiteralPath $r.FullName -Recurse -Force }
Write-Output ("prune: kept newest {0}, deleted {1} older run-dir(s)" -f $Keep, $old.Count)
