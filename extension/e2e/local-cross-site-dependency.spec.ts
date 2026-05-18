import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { ExtensionHelper } from "./page-objects";
import {
  DESTINATION_ORIGIN,
  SOURCE_JOBS_URL,
  SOURCE_ORIGIN,
  ensureLocalHarnessRunning,
  getDestinationState,
  getSourceState,
  hasLocalHarness,
  resetLocalHarness,
  stopLocalHarness,
} from "./helpers/local-harness";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const EXECUTION_GOAL = "Copy job descriptions for at least 10 jobs from the source site and create them in the destination site. Continue until 10 unique jobs are submitted.";

test.describe.configure({ mode: "serial" });
test.skip(!hasLocalHarness(), "Local cross-site harness is not installed.");

test.beforeAll(async () => {
  await ensureLocalHarnessRunning();
});

test.afterAll(async () => {
  await stopLocalHarness();
});

async function waitForContentScript(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as { __SR_CONTENT_SCRIPT__?: boolean }).__SR_CONTENT_SCRIPT__ === true, null, {
    timeout: 3_000,
  }).catch(() => {});
}

async function recordLoop(
  ext: ExtensionHelper,
  context: BrowserContext,
  loopCount: number,
): Promise<{ workflowId: string; recordedAt: number }> {
  const page = await context.newPage();
  await page.goto(SOURCE_JOBS_URL);
  await waitForContentScript(page);
  await page.waitForTimeout(300);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  await popup.page.waitForTimeout(500);
  await page.bringToFront();
  await page.waitForTimeout(250);
  expect(await popup.isRecording()).toBeTruthy();

  const recordedAt = Date.now();

  for (let jobNumber = 1; jobNumber <= loopCount; jobNumber++) {
    await expect(page.locator(`[data-testid="copy-job-${jobNumber}"]`)).toBeVisible();
    await page.click(`[data-testid="copy-job-${jobNumber}"]`);
    await page.waitForTimeout(150);

    await page.click(`[data-testid="send-job-${jobNumber}"]`);
    await page.waitForURL(new RegExp(`${DESTINATION_ORIGIN}/intake`), { timeout: 15_000 });
    await waitForContentScript(page);
    await expect(page.locator('[data-testid="prefill-status"]')).toContainText(`job-${jobNumber}`);

    await page.click('[data-testid="submit-import"]');
    await expect(page.locator('[data-testid="submit-status"]')).toContainText(`Created job-${jobNumber}`);

    if (jobNumber < loopCount) {
      await expect(page.locator('[data-testid="continue-link"]')).toBeVisible();
      await page.click('[data-testid="continue-link"]');
      await page.waitForURL(new RegExp(`${SOURCE_ORIGIN}/jobs`), { timeout: 15_000 });
      await waitForContentScript(page);
    }
  }

  await popup.page.bringToFront();
  await popup.page.waitForTimeout(400);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);
  expect(await popup.isIdle()).toBeTruthy();

  let workflowId = "";
  let fallbackWorkflowId = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const workflowsResp = await page.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    const workflows = await workflowsResp.json() as Array<{
      id: string;
      created_at: string;
      target_url?: string | null;
    }>;
    const ours = workflows
      .filter((workflow) =>
        new Date(workflow.created_at).getTime() >= recordedAt &&
        workflow.target_url?.includes(SOURCE_ORIGIN))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    fallbackWorkflowId = workflows
      .filter((workflow) => workflow.target_url?.includes(SOURCE_ORIGIN))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]?.id || fallbackWorkflowId;
    if (ours.length > 0) {
      workflowId = ours[0].id;
      break;
    }
    await page.waitForTimeout(1000);
  }

  if (!workflowId) workflowId = fallbackWorkflowId;

  await popup.page.close();
  await page.close();

  expect(workflowId).toBeTruthy();
  return { workflowId, recordedAt };
}

async function getWorkflowDetail(
  page: Page,
  workflowId: string,
): Promise<{
  steps: Array<{ action_type: string; value?: string | null; intent?: string | null }>;
}> {
  const response = await page.request.get(`${BACKEND}/v1/workflows/${workflowId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{
    steps: Array<{ action_type: string; value?: string | null; intent?: string | null }>;
  }>;
}

test("local harness records cross-site dependency steps across both origins", async ({ context, extensionId, errors }) => {
  await resetLocalHarness();

  const ext = new ExtensionHelper(context, extensionId);
  const probePage = await context.newPage();
  const { workflowId } = await recordLoop(ext, context, 3);
  const detail = await getWorkflowDetail(probePage, workflowId);

  expect(detail.steps.length).toBeGreaterThanOrEqual(10);

  const navigateValues = detail.steps
    .filter((step) => step.action_type === "navigate")
    .map((step) => step.value || "");
  expect(navigateValues.some((value) => value.includes(SOURCE_ORIGIN))).toBe(true);
  expect(navigateValues.some((value) => value.includes(DESTINATION_ORIGIN))).toBe(true);

  const copyClicks = detail.steps.filter(
    (step) => step.action_type === "click" && (step.intent || "").includes("Copy description"),
  );
  const submitClicks = detail.steps.filter(
    (step) => step.action_type === "click" && (step.intent || "").includes("Submit imported job"),
  );
  expect(copyClicks.length).toBeGreaterThanOrEqual(3);
  expect(submitClicks.length).toBeGreaterThanOrEqual(3);

  const sourceState = await getSourceState();
  const destinationState = await getDestinationState();
  expect(sourceState.exportedCount).toBe(3);
  expect(destinationState.createdCount).toBe(3);

  expect(errors.filter((error) => error.type === "console")).toHaveLength(0);
  await probePage.close();
});

test("local harness run completes 10 cross-site imports through the popup goal path", async ({ context, extensionId, errors }) => {
  test.setTimeout(600_000);
  await resetLocalHarness();

  const ext = new ExtensionHelper(context, extensionId);
  const { workflowId } = await recordLoop(ext, context, 10);

  const setupPage = await context.newPage();
  await setupPage.request.put(`${BACKEND}/v1/workflows/${workflowId}/status`, {
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    data: { status: "active" },
  });
  await setupPage.request.put(`${BACKEND}/v1/workflows/${workflowId}`, {
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    data: { target_url: null },
  });

  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  const workflowResp = await setupPage.request.get(`${BACKEND}/v1/workflows/${workflowId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(workflowResp.ok()).toBeTruthy();
  const workflowDetail = await workflowResp.json() as { name: string };

  let capturedBody: { execution_goal?: string | null } | null = null;
  await context.route(`${BACKEND}/v1/workflows/${workflowId}/run-with-params`, async (route) => {
    capturedBody = JSON.parse(route.request().postData() || "{}") as { execution_goal?: string | null };
    await route.continue();
  });

  const execPage = await context.newPage();
  await execPage.goto(SOURCE_JOBS_URL);
  await waitForContentScript(execPage);
  await execPage.bringToFront();
  await execPage.waitForTimeout(500);

  const popup = await ext.openPopup();
  await popup.page.getByText("Run Workflow").click();
  await popup.page.waitForTimeout(1200);
  await expect(popup.page.getByText("Select Workflow")).toBeVisible();
  await popup.page.getByText(workflowDetail.name).click();
  await popup.page.waitForTimeout(300);
  await expect(popup.page.getByText("Run With Goal")).toBeVisible();
  await popup.page.locator("textarea").fill(EXECUTION_GOAL);
  await popup.page.getByText("Run With Goal").click();
  await expect(popup.page.getByText("Run With Goal")).not.toBeVisible({ timeout: 10_000 });

  let runId: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const runsResp = await execPage.request.get(`${BACKEND}/v1/runs?workflow_id=${workflowId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const runs = await runsResp.json() as Array<{ id: string }>;
    if (runs.length > 0) {
      runId = runs[0].id;
      break;
    }
    await execPage.waitForTimeout(1000);
  }

  expect(runId).toBeTruthy();
  expect(capturedBody?.execution_goal).toBe(EXECUTION_GOAL);

  let finalStatus = "running";
  for (let attempt = 0; attempt < 90; attempt++) {
    await execPage.waitForTimeout(2000);
    const statusResp = await execPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const runData = await statusResp.json() as { status: string };
    finalStatus = runData.status;
    if (["completed", "failed", "waiting_for_user", "canceled"].includes(finalStatus)) break;
  }

  expect(finalStatus).toBe("completed");

  const sourceState = await getSourceState();
  const destinationState = await getDestinationState();
  expect(sourceState.exportedCount).toBe(10);
  expect(destinationState.createdCount).toBe(10);
  expect(destinationState.createdJobIds).toEqual([
    "job-1",
    "job-2",
    "job-3",
    "job-4",
    "job-5",
    "job-6",
    "job-7",
    "job-8",
    "job-9",
    "job-10",
  ]);

  expect(errors.filter((error) => error.type === "console")).toHaveLength(0);

  await popup.page.close();
  await execPage.close();
  await setupPage.close();
  await context.unroute(`${BACKEND}/v1/workflows/${workflowId}/run-with-params`);
});
