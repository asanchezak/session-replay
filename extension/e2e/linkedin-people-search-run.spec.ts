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

test.describe.configure({ mode: "serial" });

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

async function pollRunUntilTerminal(
  runId: string,
  timeoutMs: number,
): Promise<{ status: string; total_steps: number; current_step_index: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await fetch(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const s = (await r.json()) as any;
    last = s;
    if (["completed", "failed", "canceled", "waiting_for_user"].includes(String(s.status || ""))) {
      return s;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Run ${runId} did not terminate in ${timeoutMs}ms (last status: ${JSON.stringify(last)})`);
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
  pollMs: number,
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

  const final = await pollRunUntilTerminal(runId, pollMs);

  const eventsResp = await fetch(`${BACKEND}/v1/runs/${runId}/events?limit=500`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = (await eventsResp.json()) as any[];

  await searchPage.close().catch(() => {});

  return { runId, events, status: final.status };
}

test("LinkedIn people-search workflow extracts 5 profiles end-to-end", async ({ context, extensionId }) => {
  test.setTimeout(600_000);
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

  const workflowId = await seedWorkflow();
  console.log(`Seeded workflow: ${workflowId}`);

  // The hardened anti-bot path takes longer (in-tab section navigation +
  // variable dwell + jittered cooldowns + noise breaks).
  const { runId, events, status } = await runOnce(context, extensionId, workflowId, 5, 1_200_000);
  console.log(`Run ${runId} finished with status=${status}`);

  // Load-bearing assertion: the only failure mode we're hardening against
  // is LinkedIn's hard login wall. Soft pauses are acceptable.
  const stepEvents = events.filter((e) => e.event_type === "step_executed");
  const blockingPauses = events.filter(
    (e) => e.event_type === "run_paused" && /login_form/i.test(String(e.payload?.reason || "")),
  );
  expect(blockingPauses).toEqual([]);

  expect(["completed", "waiting_for_user"]).toContain(status);
  const records = profileRecords(events);
  console.log(`Profile records: ${records.length}`);
  expect(records.length).toBeGreaterThanOrEqual(4);

  // Each record should carry SOMETHING — about, skills, experience, or education.
  // Section-subset randomization means we don't always visit every section,
  // so we can't insist on a specific shape.
  for (const r of records) {
    const hasAbout = typeof r.about === "string" && r.about.length > 30;
    const hasExperience = Array.isArray(r.experience) && r.experience.length >= 1;
    const hasSkills = Array.isArray(r.skills) && r.skills.length >= 1;
    const hasEducation = Array.isArray(r.education) && r.education.length >= 1;
    expect(hasAbout || hasExperience || hasSkills || hasEducation).toBeTruthy();
  }

  // Confirm for_each was expanded by checking the audit event.
  const expanded = events.find((e) => e.event_type === "for_each_expanded");
  expect(expanded).toBeTruthy();
  expect(expanded.payload.iterations).toBeGreaterThanOrEqual(3);

  // Cadence randomization: section subsets should not all be identical.
  // For each iteration, collect the set of section names extracted (after
  // the for_each_expanded event). Profile records inherently encode this
  // via which fields are non-empty.
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
  // Not all 4+ records should have an identical section signature — variety
  // proves the randomization fired.
  expect(new Set(sectionSetPerRecord).size).toBeGreaterThan(1);

  // Noise breaks fired between iterations: expect ≥ (iterations - 1).
  const noiseEvents = stepEvents.filter(
    (e) => String(e.payload?.action_type || "") === "noise_break",
  );
  console.log("noise_break events:", noiseEvents.length);
  expect(noiseEvents.length).toBeGreaterThanOrEqual(records.length - 1);
});

test("LinkedIn people-search workflow paginates to page 2 for count=15", async ({ context, extensionId }) => {
  test.setTimeout(900_000);
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

  // Reuse the previously seeded workflow if available.
  const resp = await fetch(`${BACKEND}/v1/workflows`, { headers: { "X-API-Key": API_KEY } });
  const list = (await resp.json()) as Array<{ id: string; name: string }>;
  const wf = list.find((w) => w.name === "LinkedIn People Search");
  const workflowId = wf?.id ?? (await seedWorkflow());

  const { runId, events, status } = await runOnce(context, extensionId, workflowId, 15, 900_000);
  console.log(`Run ${runId} (count=15) finished with status=${status}`);
  // Note: LinkedIn's anti-bot detection often shows a login_form blocker after
  // ~3-10 rapid profile visits, pausing the run with waiting_for_user. The
  // important thing is pagination + iteration logic, not raw count throughput.
  expect(["completed", "waiting_for_user"]).toContain(status);

  // Page-1 and page-2 extractions should both have URLs.
  const page1 = events.find((e) => e.event_type === "extraction" && e.payload?.step_index === 1);
  const page2 = events.find((e) => e.event_type === "extraction" && e.payload?.step_index === 3);
  const urls1 = ((page1?.payload?.data || [])[0]?.profile_urls || []) as string[];
  const urls2 = ((page2?.payload?.data || [])[0]?.profile_urls || []) as string[];
  console.log(`page1 URLs: ${urls1.length}, page2 URLs: ${urls2.length}`);
  expect(urls1.length).toBeGreaterThanOrEqual(5);
  expect(urls2.length).toBeGreaterThanOrEqual(1);

  // for_each must have expanded with the larger count.
  const expanded = events.find((e) => e.event_type === "for_each_expanded");
  expect(expanded).toBeTruthy();
  expect(expanded.payload.iterations).toBeGreaterThanOrEqual(10);

  const records = profileRecords(events);
  console.log(`Profile records: ${records.length} (out of ${expanded.payload.iterations} attempted)`);
  // At least a few profiles should have been captured before any rate-limit.
  expect(records.length).toBeGreaterThanOrEqual(3);
});
