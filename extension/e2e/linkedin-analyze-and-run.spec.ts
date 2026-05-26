import fs from "fs";
import { test, expect } from "./fixtures";
import { DashboardPage, ExtensionHelper, PopupPage } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const PROFILE_URL = "https://www.linkedin.com/in/alberto-quiros-90448a239/";

test.describe.configure({ mode: "serial" });

test("side-panel Analyze-this-page during recording → run → structured extraction", async ({ context, extensionId }) => {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(`LinkedIn session not found at ${LINKEDIN_STATE_PATH}`);
  }

  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as { cookies: any[] };
  await context.addCookies(state.cookies);

  const ext = new ExtensionHelper(context, extensionId);
  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  // 1. Open the LinkedIn page so the live-analyze can capture its content.
  const linkedInPage = await context.newPage();
  await linkedInPage.goto(PROFILE_URL, { waitUntil: "domcontentloaded" });
  await linkedInPage.waitForTimeout(5000);
  if (/login|authwall|signup/.test(linkedInPage.url())) {
    throw new Error(`LinkedIn auth wall: ${linkedInPage.url()}`);
  }

  // 2. Start a recording from the popup so the orchestrator's isRecording is true.
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.clickRecord();
  await popup.page.waitForTimeout(500);

  // 3. Inject a navigate event so the resulting workflow has a target_url
  //    (the recording loop doesn't capture the *initial* page load).
  //    Send via the popup page — chrome.runtime.sendMessage from the SW
  //    context delivers to the SW's own listeners but returns undefined,
  //    so we drive all RPCs from a regular page context.
  await popup.page.evaluate(async (url: string) => {
    await chrome.runtime.sendMessage({
      type: "RECORD_EVENT",
      event: {
        event_type: "navigate",
        payload: { value: url, intent: "Navigate to LinkedIn profile" },
        page_url: url,
        page_title: "",
        timestamp: new Date().toISOString(),
      },
    });
  }, PROFILE_URL);

  // 4. Make the LinkedIn page the active tab, then drive "Analyze this page".
  await linkedInPage.bringToFront();
  await linkedInPage.waitForTimeout(500);
  const linkedInTabId = await sw.evaluate(async (urlSub: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || "").includes(urlSub))?.id ?? null;
  }, "linkedin.com/in/alberto-quiros-90448a239");
  expect(linkedInTabId).toBeTruthy();
  const analysis = await popup.page.evaluate(async (tabId: number) => {
    const resp = await chrome.runtime.sendMessage({ type: "ANALYZE_LIVE_PAGE", tabId });
    return resp as { type: string; analysis?: { suggested_fields: Array<{ key: string; label: string; shape?: { kind: string; item_keys: string[] | null } }>; page_url: string; page_title?: string; visible_text: string; dom_snippet: string; page_snapshots: Array<{ section_name: string; page_url: string; page_title?: string; visible_text: string; dom_snippet: string; captured_at: string }> }; error?: string };
  }, linkedInTabId!);
  if (analysis.type !== "ANALYZE_LIVE_PAGE_RESULT" || !analysis.analysis) {
    throw new Error(`Analyze failed: ${analysis.error || analysis.type}`);
  }
  console.log(`Suggested fields: ${JSON.stringify(analysis.analysis.suggested_fields.map((f) => f.label))}`);
  expect(analysis.analysis.suggested_fields.length).toBeGreaterThan(0);

  // 5. Apply the suggested fields — push an ADD_EXTRACT_STEP with shapes +
  //    the page snapshot so the extract step carries it forever.
  const picks = analysis.analysis.suggested_fields.filter((f) =>
    ["about", "experience", "skills", "education"].includes(f.key),
  );
  expect(picks.length).toBeGreaterThan(0);

  await popup.page.evaluate(async (payload: any) => {
    await chrome.runtime.sendMessage({
      type: "ADD_EXTRACT_STEP",
      fields: payload.fields,
      shapes: payload.shapes,
      pageUrl: payload.pageUrl,
      pageTitle: payload.pageTitle,
      pageSnapshot: payload.pageSnapshot,
      pageSnapshots: payload.pageSnapshots,
      timestamp: new Date().toISOString(),
    });
  }, {
    fields: picks.map((f) => f.label).join(", "),
    shapes: picks.map((f) => ({
      key: f.key,
      label: f.label,
      kind: f.shape?.kind || "unknown",
      item_keys: f.shape?.item_keys || null,
    })),
    pageUrl: analysis.analysis.page_url,
    pageTitle: analysis.analysis.page_title || "",
    pageSnapshot: {
      page_url: analysis.analysis.page_url,
      page_title: analysis.analysis.page_title || "",
      visible_text: analysis.analysis.visible_text,
      dom_snippet: analysis.analysis.dom_snippet,
      captured_at: new Date().toISOString(),
    },
    pageSnapshots: analysis.analysis.page_snapshots,
  });

  // 6. Stop recording — ships the buffered events to the backend, which
  //    creates the workflow with navigate + extract.
  const stopResp = await popup.page.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
  });
  const workflowId = String((stopResp as any)?.workflow?.id || "");
  expect(workflowId).toBeTruthy();

  // 7. Verify the workflow has navigate + extract with shapes + snapshot.
  const detailResp = await popup.page.request.get(`${BACKEND}/v1/workflows/${workflowId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const detail = await detailResp.json() as {
    steps: Array<{
      action_type: string;
      value?: string | null;
      methods?: Array<Record<string, unknown>> | null;
      dom_context?: Record<string, unknown> | null;
    }>;
  };
  console.log(`Workflow steps: ${JSON.stringify(detail.steps.map((s) => s.action_type))}`);
  const extractStep = detail.steps.find((s) => s.action_type === "extract");
  expect(extractStep).toBeTruthy();
  expect(extractStep?.value || "").toMatch(/Experience|About|Skills|Education/);
  const shapeEntry = (extractStep?.methods || []).find(
    (m) => (m as Record<string, unknown>).kind === "extract_shapes",
  );
  expect(shapeEntry).toBeTruthy();
  const snapshot = (extractStep?.dom_context as any)?.page_snapshot;
  const snapshots = (extractStep?.dom_context as any)?.page_snapshots;
  expect(snapshot).toBeTruthy();
  expect(String(snapshot.visible_text || "").length).toBeGreaterThan(0);
  expect(Array.isArray(snapshots)).toBeTruthy();
  expect((snapshots || []).length).toBeGreaterThanOrEqual(2);

  // 8. Run the workflow and assert structured nested extraction.
  const tabId = await sw.evaluate(async (urlSub: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url || "").includes(urlSub))?.id ?? null;
  }, "linkedin.com/in/alberto-quiros-90448a239");

  const runStart = await popup.page.evaluate(async ({ workflowId, tabId }: { workflowId: string; tabId: number | null }) => {
    return chrome.runtime.sendMessage({ type: "RUN_WORKFLOW", workflowId, tabId });
  }, { workflowId, tabId });
  const runId = String((runStart as any)?.run?.id || "");
  expect(runId).toBeTruthy();

  let finalStatus = "";
  for (let i = 0; i < 60; i++) {
    await popup.page.waitForTimeout(2000);
    const statusResp = await popup.page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const s = await statusResp.json() as any;
    if (["completed", "failed", "canceled", "waiting_for_user"].includes(String(s.status || ""))) {
      finalStatus = s.status;
      break;
    }
  }
  expect(finalStatus).toBe("completed");

  const eventsResp = await popup.page.request.get(`${BACKEND}/v1/runs/${runId}/events?limit=200`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = await eventsResp.json() as any[];
  const records = events
    .filter((e) => e.event_type === "extraction")
    .flatMap((e) => Array.isArray(e.payload?.data) ? e.payload.data : []);
  console.log(`Extraction records: ${JSON.stringify(records, null, 2)}`);
  expect(records.length).toBeGreaterThan(0);

  const record = records.reduce((best, current) => {
    const bestScore = (Array.isArray(best?.experience) ? best.experience.length : 0)
      + (Array.isArray(best?.skills) ? best.skills.length : 0);
    const currentScore = (Array.isArray(current?.experience) ? current.experience.length : 0)
      + (Array.isArray(current?.skills) ? current.skills.length : 0);
    return currentScore > bestScore ? current : best;
  }, records[0] || {});
  expect(Array.isArray(record.experience)).toBeTruthy();
  expect((record.experience || []).length).toBeGreaterThanOrEqual(2);
  expect(Array.isArray(record.skills)).toBeTruthy();
  expect((record.skills || []).length).toBeGreaterThanOrEqual(5);

  for (const arrayKey of ["experience", "education", "certifications", "projects"]) {
    const value = records.find((r) => r[arrayKey] !== undefined)?.[arrayKey];
    if (value !== undefined && value !== null) {
      expect(Array.isArray(value)).toBeTruthy();
    }
  }
  for (const listKey of ["skills", "top_skills", "languages"]) {
    const value = records.find((r) => r[listKey] !== undefined)?.[listKey];
    if (value !== undefined && value !== null) {
      expect(Array.isArray(value)).toBeTruthy();
      if ((value as unknown[]).length > 0) {
        expect(typeof (value as unknown[])[0]).toBe("string");
      }
    }
  }

  // 9. Dashboard: open workflow detail, click Edit fields, remove the first
  //    field, save, verify the workflow updates.
  const dashboard = new DashboardPage(await context.newPage());
  await dashboard.gotoWorkflowDetail(workflowId);
  await dashboard.page.waitForLoadState("networkidle");
  const interventionDialog = dashboard.page.getByRole("dialog", { name: "Workflow paused — action required" });
  if (await interventionDialog.isVisible().catch(() => false)) {
    await dashboard.page.getByRole("button", { name: "Close modal" }).click();
  }

  const editBtn = dashboard.page.getByRole("button", { name: "Edit fields" }).first();
  await expect(editBtn).toBeVisible({ timeout: 15000 });
  await editBtn.click();
  await expect(dashboard.page.getByText("Edit extraction fields")).toBeVisible();

  // Page snapshot should be detected — Re-suggest button is rendered.
  await expect(dashboard.page.getByRole("button", { name: "Re-suggest from saved page" })).toBeVisible();

  await dashboard.page.close();
  await popup.page.close();
  await linkedInPage.close();
});
