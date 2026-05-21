import fs from "fs";
import { test, expect } from "./fixtures";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const RUN_LINKEDIN_LIVE_E2E = process.env.RUN_LINKEDIN_LIVE_E2E === "true";

test.describe.configure({ mode: "serial" });
test.skip(!RUN_LINKEDIN_LIVE_E2E, "LinkedIn live navigation E2E is disabled by default. Set RUN_LINKEDIN_LIVE_E2E=true.");

type StepSpec = {
  action_type: "navigate" | "click";
  intent: string;
  value?: string;
  success_condition?: Record<string, unknown>;
};

async function createWorkflow(page: import("@playwright/test").Page, name: string, steps: StepSpec[]): Promise<string> {
  const wfResp = await page.request.post(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: {
      name,
      description: "Live LinkedIn navigation example",
      target_url: "https://www.linkedin.com/feed/",
    },
  });
  expect(wfResp.ok(), `create workflow failed: ${await wfResp.text()}`).toBe(true);
  const workflow = await wfResp.json() as { id: string };

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const stepResp = await page.request.post(`${BACKEND}/v1/workflows/${workflow.id}/steps`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: {
        step_index: index,
        action_type: step.action_type,
        intent: step.intent,
        value: step.value ?? null,
        selector_chain: step.action_type === "click" && step.value
          ? [{ type: "text", value: step.value }]
          : [],
        success_condition: step.success_condition ?? null,
      },
    });
    expect(stepResp.ok(), `add step failed: ${await stepResp.text()}`).toBe(true);
  }

  const activateResp = await page.request.put(`${BACKEND}/v1/workflows/${workflow.id}/status`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { status: "active" },
  });
  expect(activateResp.ok(), `activate workflow failed: ${await activateResp.text()}`).toBe(true);
  return workflow.id;
}

async function runWorkflow(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext,
  extensionId: string,
  workflowId: string,
): Promise<{ id: string; status: string; current_step_index: number; total_steps: number }> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2_000);
  expect(page.url()).not.toContain("/login");
  expect(page.url()).not.toContain("/authwall");

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`, { waitUntil: "domcontentloaded" });

  const started = await popup.evaluate(async ({ wf }) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targetTab = tabs.find((tab) => tab.url?.includes("linkedin.com")) || tabs[0];
    const response = await chrome.runtime.sendMessage({
      type: "RUN_WORKFLOW",
      workflowId: wf,
      tabId: targetTab?.id,
      params: {},
    });
    return response;
  }, { wf: workflowId }) as { run?: { id?: string } };

  const runId = started?.run?.id;
  expect(runId, `RUN_WORKFLOW failed: ${JSON.stringify(started)}`).toBeTruthy();

  let finalRun = null as null | {
    id: string;
    status: string;
    current_step_index: number;
    total_steps: number;
  };
  let recentEvents: Array<{ event_type?: string; payload?: Record<string, unknown> }> = [];
  let lastSignature = "";
  let stagnantPolls = 0;
  for (let attempt = 0; attempt < 60; attempt++) {
    const runResp = await page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    finalRun = await runResp.json() as typeof finalRun;
    const eventsResp = await page.request.get(`${BACKEND}/v1/runs/${runId}/events?limit=20`, {
      headers: { "X-API-Key": API_KEY },
    });
    recentEvents = eventsResp.ok()
      ? await eventsResp.json() as typeof recentEvents
      : [];
    const eventSignature = recentEvents.map((event) => {
      const payload = event.payload || {};
      return [
        event.event_type,
        payload.step_index,
        payload.success,
        payload.error,
        (payload.command as { intent?: string } | undefined)?.intent,
      ].filter((part) => part !== undefined && part !== null).join(":");
    }).join("|");
    const signature = `${finalRun?.status}:${finalRun?.current_step_index}:${eventSignature}`;
    stagnantPolls = signature === lastSignature ? stagnantPolls + 1 : 0;
    lastSignature = signature;
    if (finalRun?.status && ["completed", "failed", "canceled", "waiting_for_user"].includes(finalRun.status)) {
      break;
    }
    if (finalRun?.status === "running" && stagnantPolls >= 8) {
      const eventSummary = recentEvents.slice(-6).map((event) => {
        const payload = event.payload || {};
        return `${event.event_type}:${payload.step_index ?? ""}:${payload.success ?? ""}:${payload.error ?? ""}`;
      }).join(" | ");
      throw new Error(`LinkedIn navigation run stuck at ${finalRun.status}:${finalRun.current_step_index} run=${runId} events=${eventSummary}`);
    }
    await page.waitForTimeout(2_000);
  }
  expect(finalRun).toBeTruthy();
  expect(finalRun?.status).toBe("completed");
  expect(finalRun?.current_step_index).toBe(finalRun?.total_steps);
  await popup.close();
  return finalRun!;
}

test.beforeEach(async ({ context }) => {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(
      `LinkedIn session not found at ${LINKEDIN_STATE_PATH}.\n` +
      "Run linkedin-setup.spec.ts first: npx playwright test e2e/linkedin-setup.spec.ts --headed",
    );
  }
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Parameters<typeof context.addCookies>[0];
  };
  await context.addCookies(state.cookies);
});

test("LinkedIn top navigation: Jobs then My Network", async ({ page, context, extensionId }) => {
  test.setTimeout(4 * 60_000);
  const workflowId = await createWorkflow(page, "LinkedIn nav example: jobs to network", [
    {
      action_type: "navigate",
      intent: "Navigate to https://www.linkedin.com/feed/",
      value: "https://www.linkedin.com/feed/",
      success_condition: { type: "url_contains", value: "linkedin.com/feed" },
    },
    {
      action_type: "click",
      intent: "Click Jobs in the LinkedIn top navigation",
      value: "Jobs",
      success_condition: { type: "url_contains", value: "/jobs" },
    },
    {
      action_type: "click",
      intent: "Click My Network in the LinkedIn top navigation",
      value: "My Network",
      success_condition: { type: "url_contains", value: "/mynetwork" },
    },
  ]);

  const run = await runWorkflow(page, context, extensionId, workflowId);
  console.log(`LinkedIn nav workflow completed: ${workflowId} run=${run.id}`);
  expect(page.url()).toContain("/mynetwork");
});

test("LinkedIn top navigation: Notifications then Home", async ({ page, context, extensionId }) => {
  test.setTimeout(4 * 60_000);
  const workflowId = await createWorkflow(page, "LinkedIn nav example: notifications to home", [
    {
      action_type: "navigate",
      intent: "Navigate to https://www.linkedin.com/feed/",
      value: "https://www.linkedin.com/feed/",
      success_condition: { type: "url_contains", value: "linkedin.com/feed" },
    },
    {
      action_type: "click",
      intent: "Click Notifications in the LinkedIn top navigation",
      value: "Notifications",
      success_condition: { type: "url_contains", value: "/notifications" },
    },
    {
      action_type: "click",
      intent: "Click Home in the LinkedIn top navigation",
      value: "Home",
      success_condition: { type: "url_contains", value: "/feed" },
    },
  ]);

  const run = await runWorkflow(page, context, extensionId, workflowId);
  console.log(`LinkedIn nav workflow completed: ${workflowId} run=${run.id}`);
  expect(page.url()).toContain("/feed");
});
