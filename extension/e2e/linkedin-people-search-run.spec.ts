import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect } from "./fixtures";
import { ExtensionHelper } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const SEARCH_KEYWORD = "javascript";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEED_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "seed_linkedin_people_search.py");
const BACKEND_DIR = path.resolve(__dirname, "..", "..", "backend");

// Retries on a 30+ min run double the wall-clock for zero signal; one pass
// either proves the anti-bot stack holds or fails fast on stall.
test.describe.configure({ mode: "serial", retries: 0 });

// Anti-bot pacing makes wall-clock grow linearly with `count` and high-variance
// per iteration (variable dwell, jittered cooldowns, extended cooldowns every
// Nth iteration, noise navigations). A single hardcoded timeout collapses
// "long" and "stuck" into one signal — we separate them:
//   - stallMs: max time without `current_step_index` progress before we treat
//     the run as wedged. Sized for the worst legitimate gap between
//     step_result reports (extended cooldown 90s + iter delay 50s + noise
//     activity 20s + section dwell + nav settle ≈ 3 min; 5 min gives ~2× margin).
//   - ceilingMs: paranoid upper bound; never tight, only there to bound a
//     silent backend hang. Scales with count.
//   - testTimeoutMs: outer Playwright budget, slightly above ceilingMs.
function runtimeBudget(count: number): {
  stallMs: number;
  ceilingMs: number;
  testTimeoutMs: number;
} {
  const perProfileMs = 4 * 60_000;
  const overheadMs = 5 * 60_000;
  const ceilingMs = overheadMs + count * perProfileMs;
  const stallMs = 5 * 60_000;
  const testTimeoutMs = Math.ceil(ceilingMs * 1.1);
  return { stallMs, ceilingMs, testTimeoutMs };
}

async function seedWorkflow(): Promise<string> {
  // Re-run the idempotent seed and resolve the workflow id via the API.
  const seed = spawnSync(
    path.join(BACKEND_DIR, ".venv", "bin", "python"),
    [SEED_SCRIPT],
    { cwd: BACKEND_DIR, encoding: "utf-8", env: { ...process.env } },
  );
  if (seed.status !== 0) {
    throw new Error(`Seed failed: ${seed.stderr}\n${seed.stdout}`);
  }
  const resp = await fetch(`${BACKEND}/v1/workflows`, { headers: { "X-API-Key": API_KEY } });
  if (!resp.ok) throw new Error(`workflows list failed: ${resp.status}`);
  const list = (await resp.json()) as Array<{ id: string; name: string }>;
  const match = list.find((w) => w.name === "LinkedIn People Search");
  if (!match) throw new Error("Seeded workflow not found in /v1/workflows");
  return match.id;
}

type RunSnapshot = {
  status: string;
  total_steps: number;
  current_step_index: number;
  pause_reason?: string | null;
};

// Progress = current_step_index advanced OR status string changed. If neither
// moves for stallMs, the run is treated as wedged and we throw. If the run
// reaches a terminal status we return its snapshot. The hardCeilingMs is the
// last-resort failsafe — it should never realistically fire on a healthy run.
async function pollRunUntilDoneOrStalled(
  runId: string,
  opts: { stallMs: number; ceilingMs: number; pollIntervalMs?: number },
): Promise<RunSnapshot> {
  const { stallMs, ceilingMs, pollIntervalMs = 3000 } = opts;
  const hardDeadline = Date.now() + ceilingMs;
  let lastProgressAt = Date.now();
  let lastStep = -1;
  let lastStatus = "";
  let last: RunSnapshot | null = null;
  while (Date.now() < hardDeadline) {
    const r = await fetch(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const s = (await r.json()) as RunSnapshot;
    last = s;
    const status = String(s.status || "");
    if (["completed", "failed", "canceled", "waiting_for_user"].includes(status)) {
      return s;
    }
    if (s.current_step_index !== lastStep || status !== lastStatus) {
      lastStep = s.current_step_index;
      lastStatus = status;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallMs) {
      throw new Error(
        `Run ${runId} stalled at step ${lastStep}/${s.total_steps} for ${stallMs}ms (status=${status})`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `Run ${runId} exceeded hard ceiling ${ceilingMs}ms (last: ${JSON.stringify(last)})`,
  );
}

function profileRecords(events: any[]): any[] {
  return events
    .filter((e) => e.event_type === "extraction")
    .flatMap((e) => Array.isArray(e.payload?.data) ? e.payload.data : [])
    .filter((r) => typeof r === "object" && r && (r.experience || r.skills || r.about));
}

async function runOnce(
  context: any,
  extensionId: string,
  workflowId: string,
  count: number,
): Promise<{ runId: string; events: any[]; status: string }> {
  // Only one visible page: the LinkedIn search tab the agent loop drives.
  // No popup, no extra blank tabs flashing during the run.
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${SEARCH_KEYWORD}&origin=SWITCH_SEARCH_VERTICAL`;
  const searchPage = await context.newPage();
  await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await searchPage.waitForTimeout(5000);
  if (/login|authwall|signup/.test(searchPage.url())) {
    await searchPage.close().catch(() => {});
    test.skip(true, `LinkedIn auth wall — anti-bot rate-limited this session: ${searchPage.url()}`);
  }
  await searchPage.bringToFront();

  const ext = new ExtensionHelper(context, extensionId);
  const sw = await ext.getServiceWorker();
  const tabId = await sw.evaluate(async (urlSub: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || "").includes(urlSub))?.id ?? null;
  }, "linkedin.com/search/results/people");
  expect(tabId).toBeTruthy();

  // Kick off the agent loop directly inside the service worker without
  // awaiting the long-running promise (otherwise sw.evaluate hangs for the
  // entire run). The onStart callback resolves with the run id as soon as
  // the backend creates the run.
  const runId = await sw.evaluate(
    ({ workflowId, tabId, params }: { workflowId: string; tabId: number | null; params: Record<string, unknown> }) => {
      const g = self as unknown as Record<string, any>;
      if (typeof g.__executeAgentRun !== "function") {
        throw new Error("__executeAgentRun not exposed on service worker");
      }
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const onStart = (handle: { id: string }) => {
          if (!settled) {
            settled = true;
            resolve(handle.id);
          }
        };
        g.__executeAgentRun(workflowId, tabId, undefined, params, onStart)
          .catch((err: unknown) => {
            if (!settled) {
              settled = true;
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
      });
    },
    { workflowId, tabId, params: { keyword: SEARCH_KEYWORD, count } },
  );
  expect(runId).toBeTruthy();
  console.log(`Started run ${runId} with count=${count}`);

  const { stallMs, ceilingMs } = runtimeBudget(count);
  const final = await pollRunUntilDoneOrStalled(runId, { stallMs, ceilingMs });

  const eventsResp = await fetch(`${BACKEND}/v1/runs/${runId}/events?limit=500`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = (await eventsResp.json()) as any[];

  await searchPage.close().catch(() => {});

  return { runId, events, status: final.status };
}

// Generic body so we can add count=15, count=30, count=50 cases by tacking on
// another test() without forking the assertions.
async function runPeopleSearchEndToEnd(
  context: any,
  extensionId: string,
  count: number,
): Promise<void> {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(`LinkedIn session not found at ${LINKEDIN_STATE_PATH}`);
  }
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as { cookies: any[] };
  await context.addCookies(state.cookies);

  const ext = new ExtensionHelper(context, extensionId);
  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => chrome.storage.session.set({ apiBaseUrl, apiKey }), {
    apiBaseUrl: `${BACKEND}/v1`,
    apiKey: API_KEY,
  });

  // Reuse the previously seeded workflow if available — seed is idempotent
  // but skipping the re-seed shaves a few seconds.
  const resp = await fetch(`${BACKEND}/v1/workflows`, { headers: { "X-API-Key": API_KEY } });
  const list = (await resp.json()) as Array<{ id: string; name: string }>;
  const wf = list.find((w) => w.name === "LinkedIn People Search");
  const workflowId = wf?.id ?? (await seedWorkflow());
  console.log(`Workflow: ${workflowId}`);

  const { runId, events, status } = await runOnce(context, extensionId, workflowId, count);
  console.log(`Run ${runId} (count=${count}) finished with status=${status}`);

  // Load-bearing: LinkedIn's login_form interstitial is the only signal that
  // the anti-bot stack has failed. Soft pauses (tab_closed, rate_limited)
  // are acceptable, hard login walls are not.
  const stepEvents = events.filter((e) => e.event_type === "step_executed");
  const blockingPauses = events.filter(
    (e) => e.event_type === "run_paused" && /login_form/i.test(String(e.payload?.reason || "")),
  );
  expect(blockingPauses).toEqual([]);

  expect(["completed", "waiting_for_user"]).toContain(status);

  // for_each materializes min(count, available_urls) iterations. The seed's
  // pagination ceiling currently caps URL supply at page-2 (~20-25 URLs for a
  // common keyword), so a count larger than that is bounded by URL supply.
  // That's a workflow limit, not an anti-bot signal — the test still verifies
  // the for_each expansion matches the requested count up to supply.
  const expanded = events.find((e) => e.event_type === "for_each_expanded");
  expect(expanded).toBeTruthy();
  const forEachOriginStep = expanded.payload.step_index as number;
  const iterations = expanded.payload.iterations as number;

  // Search-page extractions are the extraction events whose step_index sits
  // BEFORE the for_each origin step. Sort ascending — first is page 1,
  // second is page 2. Deriving from event order, not hardcoded indices,
  // keeps this robust if the workflow is restructured.
  const searchExtracts = events
    .filter((e) => e.event_type === "extraction" && (e.payload?.step_index ?? -1) < forEachOriginStep)
    .sort((a, b) => (a.payload?.step_index ?? 0) - (b.payload?.step_index ?? 0));
  const urls1 = ((searchExtracts[0]?.payload?.data || [])[0]?.profile_urls || []) as string[];
  const urls2 = ((searchExtracts[1]?.payload?.data || [])[0]?.profile_urls || []) as string[];
  console.log(`page1 URLs: ${urls1.length}, page2 URLs: ${urls2.length}`);
  // Page 1 always populates (~10 results). Page 2 may be sparse on niche
  // keywords but for `javascript` we expect ≥1.
  expect(urls1.length).toBeGreaterThanOrEqual(5);
  expect(urls2.length).toBeGreaterThanOrEqual(1);

  const urlsAvailable = urls1.length + urls2.length;
  expect(iterations).toBe(Math.min(count, urlsAvailable));

  const records = profileRecords(events);
  console.log(`Profile records: ${records.length} (of ${iterations} iterations)`);
  // Records floor scales with the actual iteration count (after URL-supply
  // capping), not the requested count. 40% of iterations tolerates the
  // sparse-iteration variance the anti-bot path produces while still failing
  // hard if the stack is broken.
  const recordsFloor = Math.max(3, Math.ceil(iterations * 0.4));
  expect(records.length).toBeGreaterThanOrEqual(recordsFloor);

  // Each record should carry SOMETHING — section-subset randomization means
  // we don't insist on a specific shape, just that the iteration captured
  // *some* structured data.
  for (const r of records) {
    const hasAbout = typeof r.about === "string" && r.about.length > 30;
    const hasExperience = Array.isArray(r.experience) && r.experience.length >= 1;
    const hasSkills = Array.isArray(r.skills) && r.skills.length >= 1;
    const hasEducation = Array.isArray(r.education) && r.education.length >= 1;
    expect(hasAbout || hasExperience || hasSkills || hasEducation).toBeTruthy();
  }

  // Cadence randomization: section subsets across iterations must show variety.
  // If every record has the exact same field signature, the randomization
  // didn't fire (or every page coincidentally exposed identical sections).
  const sectionSetPerRecord = records.map((r) =>
    [
      r.about ? "about" : null,
      Array.isArray(r.skills) && r.skills.length ? "skills" : null,
      Array.isArray(r.experience) && r.experience.length ? "experience" : null,
      Array.isArray(r.education) && r.education.length ? "education" : null,
      Array.isArray(r.certifications) && r.certifications.length ? "certifications" : null,
      Array.isArray(r.projects) && r.projects.length ? "projects" : null,
    ].filter(Boolean).sort().join(","),
  );
  console.log("Section sets per record:", sectionSetPerRecord);
  expect(new Set(sectionSetPerRecord).size).toBeGreaterThan(1);

  // Noise-break invariant: one pre-warm idle_scroll + one inter-iteration
  // noise step per for_each iteration boundary. The number of iteration
  // navigates that actually ran bounds the lower edge — if the run aborted
  // mid-iteration we tolerate one extra noise (its preceding nav didn't
  // land).
  const noiseEvents = stepEvents.filter(
    (e) => String(e.payload?.action_type || "") === "noise_break",
  );
  const innerNavigates = stepEvents.filter(
    (e) =>
      String(e.payload?.action_type || "") === "navigate" &&
      (e.payload?.step_index ?? 0) > forEachOriginStep,
  ).length;
  console.log(`noise_break: ${noiseEvents.length}, inner navigates: ${innerNavigates}`);
  // 1 pre-warm + (innerNavigates - 1 if at least one inner nav) inter-iteration
  // = innerNavigates total (when ≥1 nav). If 0 inner navs happened we still
  // saw the pre-warm noise from the static workflow steps.
  const expectedNoiseLower = Math.max(1, innerNavigates);
  expect(noiseEvents.length).toBeGreaterThanOrEqual(expectedNoiseLower);
  // Tolerance: if the run aborted between an inter-iteration noise and its
  // following nav, noise can lead navs by exactly one.
  expect(noiseEvents.length).toBeLessThanOrEqual(expectedNoiseLower + 1);
}

test("LinkedIn people-search workflow extracts 5 profiles end-to-end", async ({ context, extensionId }) => {
  test.setTimeout(runtimeBudget(5).testTimeoutMs);
  await runPeopleSearchEndToEnd(context, extensionId, 5);
});

test("LinkedIn people-search workflow paginates to page 2 for count=15", async ({ context, extensionId }) => {
  test.setTimeout(runtimeBudget(15).testTimeoutMs);
  await runPeopleSearchEndToEnd(context, extensionId, 15);
});
