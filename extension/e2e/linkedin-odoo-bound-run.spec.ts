import fs from "fs";
import { expect, test } from "./fixtures";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const WORKFLOW_ID = process.env.LINKEDIN_ODOO_WORKFLOW_ID || "cf827aa1-3bfb-484d-94fd-ae27d35567d3";
const RUN_LINKEDIN_LIVE_E2E = process.env.RUN_LINKEDIN_LIVE_E2E === "true";

test.describe.configure({ mode: "serial" });
test.skip(!RUN_LINKEDIN_LIVE_E2E, "LinkedIn live replay E2E is disabled by default. Set RUN_LINKEDIN_LIVE_E2E=true.");

type PreviewResponse = {
  resolved_value: string;
  source_record: {
    job_id: string;
    job_title: string;
    job_description: string;
  };
};

type WorkflowDetail = {
  connector_bindings?: Array<{
    parameter_key: string;
    connector_id: string;
    source_kind: string;
    template: string;
    job_filters?: Record<string, unknown>;
    enabled?: boolean;
  }>;
};

type RunDetail = {
  status?: string;
  current_step_index?: number;
  total_steps?: number;
  error_summary?: string | null;
  resolved_parameters?: Record<string, string>;
  connector_resolution?: Array<{
    source_record?: {
      job_id?: string;
      job_title?: string;
      job_description?: string;
    };
    resolved_value?: string;
  }>;
};

function firstMeaningfulDescriptionLine(description: string): string {
  return description
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 10) || description.trim();
}

test("LinkedIn workflow completes and sends the Odoo job description message", async ({ context, extensionId }) => {
  test.setTimeout(8 * 60_000);

  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(
      `LinkedIn session not found at ${LINKEDIN_STATE_PATH}.\n`
      + "Run linkedin-setup.spec.ts first: npx playwright test e2e/linkedin-setup.spec.ts --headed",
    );
  }

  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }>;
  };
  await context.addCookies(state.cookies);

  const api = context.request;
  const activateResp = await api.put(`${BACKEND}/v1/workflows/${WORKFLOW_ID}/status`, {
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    data: { status: "active" },
  });
  if (!activateResp.ok()) {
    const body = await activateResp.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    const alreadyActive = body?.error?.code === "INVALID_TRANSITION"
      && (body.error.message || "").toLowerCase().includes("active");
    if (!alreadyActive) {
      throw new Error(`Failed to activate workflow ${WORKFLOW_ID}: ${JSON.stringify(body)}`);
    }
  }

  const workflowResp = await api.get(`${BACKEND}/v1/workflows/${WORKFLOW_ID}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(workflowResp.ok()).toBeTruthy();
  const workflow = await workflowResp.json() as WorkflowDetail;
  const binding = workflow.connector_bindings?.find((item) => item.parameter_key === "recipient");
  expect(binding).toBeTruthy();

  const previewResp = await api.post(
    `${BACKEND}/v1/workflows/${WORKFLOW_ID}/connector-bindings/recipient/preview`,
    {
      headers: {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json",
      },
      data: {
        connector_id: binding?.connector_id,
        source_kind: binding?.source_kind,
        template: binding?.template,
        job_filters: binding?.job_filters || {},
        enabled: binding?.enabled ?? true,
      },
    },
  );
  expect(previewResp.ok()).toBeTruthy();
  const previewBody = await previewResp.json() as { preview: PreviewResponse };
  const preview = previewBody.preview;
  const titleNeedle = preview.source_record.job_title;
  const descriptionNeedle = firstMeaningfulDescriptionLine(preview.source_record.job_description);
  expect(titleNeedle).toBeTruthy();
  expect(descriptionNeedle).toBeTruthy();
  expect(preview.resolved_value).toContain(titleNeedle);
  expect(preview.resolved_value).toContain(descriptionNeedle);

  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  if (page.url().includes("/login") || page.url().includes("/authwall")) {
    throw new Error("LinkedIn session is invalid or expired. Re-run linkedin-setup.spec.ts.");
  }

  await page.evaluate(() => {
    try {
      const toggle = document.querySelector<HTMLElement>(
        ".msg-overlay-list-bubble--is-active button[aria-label*='Minimize'], "
        + ".msg-overlay-list-bubble--is-active button[aria-label*='Close']",
      );
      if (toggle) toggle.click();
    } catch {
      // no-op
    }
  });
  await page.waitForTimeout(800);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`, { waitUntil: "domcontentloaded" });
  await popup.waitForTimeout(800);

  const runStart = await popup.evaluate(async ({ workflowId }) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targetTab = tabs.find((tab) => tab.url?.includes("linkedin.com/feed"))
      || tabs.find((tab) => tab.url?.includes("linkedin.com"))
      || tabs[0];

    const response = await chrome.runtime.sendMessage({
      type: "RUN_WORKFLOW",
      workflowId,
      tabId: targetTab?.id,
    });

    return { tabId: targetTab?.id ?? null, response };
  }, { workflowId: WORKFLOW_ID });

  const runId = (runStart as { response?: { run?: { id?: string } } })?.response?.run?.id;
  expect(runId, `RUN_WORKFLOW failed: ${JSON.stringify(runStart)}`).toBeTruthy();

  const terminal = new Set(["completed", "failed", "canceled", "waiting_for_user"]);
  let finalRun: RunDetail | null = null;
  let lastSignature = "";
  let stagnantPolls = 0;

  for (let attempt = 0; attempt < 180; attempt++) {
    const runResp = await api.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    finalRun = await runResp.json() as RunDetail;
    const signature = `${finalRun?.status ?? "unknown"}:${finalRun?.current_step_index ?? "?"}`;
    if (signature === lastSignature) {
      stagnantPolls += 1;
    } else {
      stagnantPolls = 0;
      lastSignature = signature;
    }

    if ((finalRun?.status || "") === "running" && stagnantPolls >= 25) {
      throw new Error(
        `Run stuck at ${signature} for about ${stagnantPolls * 2}s`
        + `${finalRun?.error_summary ? ` (${finalRun.error_summary})` : ""}`,
      );
    }

    if (finalRun?.status && terminal.has(finalRun.status)) {
      break;
    }
    await page.waitForTimeout(2_000);
  }

  expect(finalRun).toBeTruthy();
  expect(finalRun?.status).toBe("completed");
  expect(finalRun?.current_step_index).toBe(finalRun?.total_steps);
  expect(finalRun?.resolved_parameters?.recipient).toBe(preview.resolved_value);
  expect(finalRun?.connector_resolution?.[0]?.source_record?.job_id).toBe(preview.source_record.job_id);
  expect(finalRun?.resolved_parameters?.recipient).toContain(titleNeedle);
  expect(finalRun?.resolved_parameters?.recipient).toContain(descriptionNeedle);

  const eventsResp = await api.get(`${BACKEND}/v1/runs/${runId}/events?limit=120`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(eventsResp.ok()).toBeTruthy();
  const events = await eventsResp.json() as Array<{
    event_type?: string;
    payload?: {
      step_index?: number;
      success?: boolean;
      error?: string | null;
    };
  }>;
  const sendStep = events.find((event) =>
    event.event_type === "step_executed"
    && event.payload?.step_index === 5,
  );
  expect(sendStep?.payload?.success).toBe(true);
});
