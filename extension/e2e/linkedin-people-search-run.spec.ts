import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect } from "./fixtures";
import { ExtensionHelper, PopupPage } from "./page-objects";
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
  request: PopupPage["page"]["request"],
  runId: string,
  timeoutMs: number,
): Promise<{ status: string; total_steps: number; current_step_index: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const r = await request.get(`${BACKEND}/v1/runs/${runId}`, {
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
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.page.waitForTimeout(500);

  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${SEARCH_KEYWORD}&origin=SWITCH_SEARCH_VERTICAL`;
  const searchPage = await context.newPage();
  await searchPage.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await searchPage.waitForTimeout(5000);
  if (/login|authwall|signup/.test(searchPage.url())) {
    // LinkedIn's anti-bot has flagged this session. Outside our control; skip
    // the test so it doesn't blockedly fail.
    await searchPage.close().catch(() => {});
    await popup.page.close().catch(() => {});
    test.skip(true, `LinkedIn auth wall — anti-bot rate-limited this session: ${searchPage.url()}`);
  }
  await searchPage.bringToFront();

  // Resolve the search tab's id from the service worker.
  const ext = new ExtensionHelper(context, extensionId);
  const sw = await ext.getServiceWorker();
  const tabId = await sw.evaluate(async (urlSub: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || "").includes(urlSub))?.id ?? null;
  }, "linkedin.com/search/results/people");
  expect(tabId).toBeTruthy();

  const runResp = await popup.page.evaluate(
    async ({ workflowId, tabId, params }: { workflowId: string; tabId: number | null; params: Record<string, unknown> }) => {
      return chrome.runtime.sendMessage({ type: "RUN_WORKFLOW", workflowId, tabId, params });
    },
    { workflowId, tabId, params: { keyword: SEARCH_KEYWORD, count } },
  );
  const runId = String((runResp as any)?.run?.id || "");
  expect(runId).toBeTruthy();
  console.log(`Started run ${runId} with count=${count}`);

  const final = await pollRunUntilTerminal(popup.page.request, runId, pollMs);

  const eventsResp = await popup.page.request.get(`${BACKEND}/v1/runs/${runId}/events?limit=500`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = (await eventsResp.json()) as any[];

  await searchPage.close().catch(() => {});
  await popup.page.close().catch(() => {});

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

  const { runId, events, status } = await runOnce(context, extensionId, workflowId, 5, 300_000);
  console.log(`Run ${runId} finished with status=${status}`);

  expect(status).toBe("completed");
  const records = profileRecords(events);
  console.log(`Profile records: ${records.length}`);
  expect(records.length).toBeGreaterThanOrEqual(3);
  expect(records.length).toBeLessThanOrEqual(5);

  // Each record should have at least some richness — about + experience or skills.
  for (const r of records) {
    const hasAbout = typeof r.about === "string" && r.about.length > 30;
    const hasExperience = Array.isArray(r.experience) && r.experience.length >= 1;
    const hasSkills = Array.isArray(r.skills) && r.skills.length >= 3;
    expect(hasAbout || hasExperience || hasSkills).toBeTruthy();
  }

  // Confirm for_each was expanded by checking the audit event.
  const expanded = events.find((e) => e.event_type === "for_each_expanded");
  expect(expanded).toBeTruthy();
  expect(expanded.payload.iterations).toBeGreaterThanOrEqual(3);
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
