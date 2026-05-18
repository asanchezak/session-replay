import { test, expect } from "./fixtures";
import { ExtensionHelper, PopupPage } from "./page-objects";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("popup Run With Goal creates a run and dismisses the goal input", async ({ context, extensionId, errors }) => {
  const ext = new ExtensionHelper(context, extensionId);
  const workflowName = `Goal Run ${Date.now()}`;
  const executionGoal = "Open the site and validate the first heading";
  let capturedExecutionGoal: string | null = null;

  const wfId = await ext.createWorkflowViaAPI(workflowName, [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { target: { selector: "h1" }, intent: "Click the main heading" } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  await context.route(`${BACKEND}/v1/workflows/${wfId}/run-with-params`, async (route) => {
    const request = route.request();
    try {
      const payload = JSON.parse(request.postData() || "{}") as { execution_goal?: string | null };
      capturedExecutionGoal = payload.execution_goal ?? null;
    } catch {
      capturedExecutionGoal = null;
    }
    await route.continue();
  });

  const execPage = await context.newPage();
  await execPage.goto("https://example.com");
  await execPage.bringToFront();
  await execPage.waitForTimeout(1000);

  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.page.waitForTimeout(1000);

  await popup.page.getByText("Run Workflow").click();
  await popup.page.waitForTimeout(1500);
  await expect(popup.page.getByText("Select Workflow")).toBeVisible();

  await popup.page.getByText(workflowName).click();
  await popup.page.waitForTimeout(300);
  await expect(popup.page.getByText("Run With Goal")).toBeVisible();

  const goalInput = popup.page.locator("textarea");
  await goalInput.fill(executionGoal);
  await popup.page.getByText("Run With Goal").click();

  await expect(popup.page.getByText("Run With Goal")).not.toBeVisible({ timeout: 10000 });

  let runRecord: any = null;
  for (let attempt = 0; attempt < 15; attempt++) {
    const runsResp = await execPage.request.get(`${BACKEND}/v1/runs?workflow_id=${wfId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const runs = await runsResp.json() as any[];
    if (runs.length > 0) {
      runRecord = runs[0];
      break;
    }
    await execPage.waitForTimeout(1000);
  }

  expect(runRecord).toBeTruthy();
  expect(capturedExecutionGoal).toBe(executionGoal);

  const showsIdle = await popup.page.getByText("Record Workflow").isVisible().catch(() => false);
  const showsRunning = await popup.page.getByText(/Step \d+\/\d+/).isVisible().catch(() => false);
  const showsWaiting = await popup.page.getByText("Action Required").isVisible().catch(() => false);
  const showsError = await popup.page.getByText("Error").isVisible().catch(() => false);

  expect(showsIdle || showsRunning || showsWaiting || showsError).toBe(true);
  expect(errors.filter((e) => e.type === "console")).toHaveLength(0);

  await popup.page.close();
  await execPage.close();
  await context.unroute(`${BACKEND}/v1/workflows/${wfId}/run-with-params`);
});

test("dashboard bridge forwards goal and runtime params to run-with-params", async ({ context, extensionId, errors }) => {
  const ext = new ExtensionHelper(context, extensionId);
  const workflowName = `Bridge Run ${Date.now()}`;
  const executionGoal = "Extract the main heading from the current page";
  const runtimeParams = { target_url: "https://example.com/?from=dashboard" };
  let capturedBody: { execution_goal?: string | null; runtime_params?: Record<string, unknown> | null } | null = null;

  const wfId = await ext.createWorkflowViaAPI(workflowName, [
    { event_type: "navigate", payload: { url: "{{target_url}}" } },
    { event_type: "click", payload: { target: { selector: "h1" }, intent: "Click the main heading" } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  await context.route(`${BACKEND}/v1/workflows/${wfId}/run-with-params`, async (route) => {
    const request = route.request();
    capturedBody = JSON.parse(request.postData() || "{}") as {
      execution_goal?: string | null;
      runtime_params?: Record<string, unknown> | null;
    };
    await route.continue();
  });

  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.bringToFront();
  await page.waitForTimeout(1000);

  const startedRunId = await page.evaluate(({ workflowId, goal, params }) => {
    return new Promise<string | null>((resolve) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, 10000);
      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.type === "DASHBOARD_RUN_STARTED" && typeof event.data.runId === "string") {
          window.clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve(event.data.runId);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ type: "DASHBOARD_RUN_WORKFLOW", workflowId, goal, params }, "*");
    });
  }, { workflowId: wfId, goal: executionGoal, params: runtimeParams });

  expect(startedRunId).toBeTruthy();
  expect(capturedBody?.execution_goal).toBe(executionGoal);
  expect(capturedBody?.runtime_params).toEqual(runtimeParams);

  const runDetailResp = await page.request.get(`${BACKEND}/v1/runs/${startedRunId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(runDetailResp.ok()).toBeTruthy();

  expect(errors.filter((e) => e.type === "console")).toHaveLength(0);

  await page.close();
  await context.unroute(`${BACKEND}/v1/workflows/${wfId}/run-with-params`);
});

test("dashboard bridge forwards RUN_FAILED with the backend error message", async ({ context, extensionId, errors }) => {
  const ext = new ExtensionHelper(context, extensionId);
  const workflowName = `Bridge Failure ${Date.now()}`;

  const wfId = await ext.createWorkflowViaAPI(workflowName, [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  await context.route(`${BACKEND}/v1/workflows/${wfId}/run-with-params`, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "run_start_failed",
          message: "Simulated bridge failure",
          details: null,
        },
      }),
    });
  });

  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.bringToFront();
  await page.waitForTimeout(1000);

  const failureMessage = await page.evaluate(({ workflowId }) => {
    return new Promise<string | null>((resolve) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, 10000);
      const handler = (event: MessageEvent) => {
        if (event.source !== window) return;
        if (event.data?.type === "DASHBOARD_RUN_FAILED") {
          window.clearTimeout(timeout);
          window.removeEventListener("message", handler);
          resolve(typeof event.data.error === "string" ? event.data.error : null);
        }
      };
      window.addEventListener("message", handler);
      window.postMessage({ type: "DASHBOARD_RUN_WORKFLOW", workflowId }, "*");
    });
  }, { workflowId: wfId });

  expect(failureMessage).toContain("Simulated bridge failure");
  expect(errors.filter((e) => e.type === "console")).toHaveLength(0);

  await page.close();
  await context.unroute(`${BACKEND}/v1/workflows/${wfId}/run-with-params`);
});
