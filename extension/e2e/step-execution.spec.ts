import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = "dev-api-key-change-in-production";

/**
 * Tests for the extension-driven step execution and verification.
 *
 * These tests exercise the actual executeWorkflowRun function in the
 * service worker — not just API calls. They verify that steps are
 * executed on real browser pages, success/failure is reported, and
 * the run transitions to the correct terminal state.
 */

test("runs workflow through extension and completes all steps", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  // Create a workflow with steps on a stable page
  const wfId = await ext.createWorkflowViaAPI("E2E Step Execution", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { target: { selector: "h1" } } },
    { event_type: "click", payload: { target: { selector: "p" } } },
  ]);
  expect(wfId).toBeTruthy();
  console.log(`  Created workflow: ${wfId}`);

  // Open the target page so the content script is loaded
  const execPage = await context.newPage();
  await execPage.goto("https://example.com");
  await execPage.waitForTimeout(2000);
  console.log(`  Opened: ${execPage.url()}`);

  // Trigger execution via __executeWorkflowRun on the service worker
  const sw = await ext.getServiceWorker();

  // First make the execution tab active
  const execTabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ url: "https://example.com/*" }, (tabs) => {
        resolve(tabs[0]?.id);
      });
    });
  });
  console.log(`  Execution tab ID: ${execTabId}`);
  expect(execTabId).toBeDefined();

  // Call the embedded __executeWorkflowRun function
  const runResult = await sw.evaluate(async ({ workflowId, tabId }: { workflowId: string; tabId: number }) => {
    const fn = (self as any).__executeWorkflowRun as
      (workflowId: string, tabId?: number) => Promise<{ id: string; status: string; total_steps: number }>;
    return await fn(workflowId, tabId);
  }, { workflowId: wfId, tabId: execTabId });

  console.log(`  Run result: ${JSON.stringify(runResult)}`);
  expect(runResult).toBeDefined();
  const runId = runResult.id;
  console.log(`  Run ID: ${runId}`);

  // Wait for run to complete on the backend
  let finalStatus = "";
  let finalStep = -1;
  for (let attempt = 0; attempt < 30; attempt++) {
    const resp = await execPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await resp.json() as any;
    finalStatus = run.status;
    finalStep = run.current_step_index;
    if (finalStatus === "completed" || finalStatus === "failed") {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`  Final status: ${finalStatus}, step: ${finalStep}/3`);
  expect(finalStatus).toBe("completed");
  // The navigate step, then click h1, then click p = 3 steps
  expect(finalStep).toBe(3);

  // Verify audit trail has step_executed events for all steps
  const auditResp = await execPage.request.get(`${BACKEND}/v1/audit/${runId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const auditData = await auditResp.json() as any;
  const audit = Array.isArray(auditData) ? auditData : (auditData.events || []);
  const stepEvents = audit.filter((e: any) => e.event_type === "step_executed");
  console.log(`  Step-executed audit events: ${stepEvents.length}`);
  expect(stepEvents.length).toBe(3);

  // All step events should have success=true
  for (const ev of stepEvents) {
    expect(ev.payload.success).toBe(true);
  }

  // Verify hash chain integrity
  for (let i = 1; i < audit.length; i++) {
    expect(audit[i].previous_hash).toBe(audit[i - 1].hash);
  }
  console.log("  Audit hash chain: VERIFIED");

  await execPage.close();
});

test("stops execution on step failure and reports failed status", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  // Create a workflow where the second step will fail (non-existent selector)
  const wfId = await ext.createWorkflowViaAPI("E2E Step Failure", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { target: { selector: "#this-element-does-not-exist-on-the-page" } } },
  ]);
  expect(wfId).toBeTruthy();
  console.log(`  Created failure workflow: ${wfId}`);

  const execPage = await context.newPage();
  await execPage.goto("https://example.com");
  await execPage.waitForTimeout(2000);

  const sw = await ext.getServiceWorker();

  const execTabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ url: "https://example.com/*" }, (tabs) => {
        resolve(tabs[0]?.id);
      });
    });
  });
  expect(execTabId).toBeDefined();

  const runResult = await sw.evaluate(async ({ workflowId, tabId }: { workflowId: string; tabId: number }) => {
    const fn = (self as any).__executeWorkflowRun as
      (workflowId: string, tabId?: number) => Promise<{ id: string; status: string; total_steps: number }>;
    return await fn(workflowId, tabId);
  }, { workflowId: wfId, tabId: execTabId });

  console.log(`  Run result: ${JSON.stringify(runResult)}`);
  expect(runResult).toBeDefined();
  const runId = runResult.id;
  console.log(`  Run ID: ${runId}`);

  // Wait for run to complete on the backend
  let finalStatus = "";
  let finalStep = -1;
  let errorSummary: string | null = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    const resp = await execPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await resp.json() as any;
    finalStatus = run.status;
    finalStep = run.current_step_index;
    errorSummary = run.error_summary;
    if (finalStatus === "completed" || finalStatus === "failed") {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`  Final status: ${finalStatus}, step: ${finalStep}/2, error: ${errorSummary}`);
  // Healing system intercepts failures — run may be "waiting_for_user" or "failed"
  expect(["failed", "waiting_for_user"]).toContain(finalStatus);
  // Step 0 (navigate) succeeded, step 1 failed — step index should be 1
  expect(finalStep).toBe(1);
  if (finalStatus === "failed") {
    expect(errorSummary).toBeTruthy();
    expect(errorSummary).toContain("not found");
  }

  // Verify audit trail has the step failure
  const auditResp = await execPage.request.get(`${BACKEND}/v1/audit/${runId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const auditData = await auditResp.json() as any;
  const audit = Array.isArray(auditData) ? auditData : (auditData.events || []);
  const stepEvents = audit.filter((e: any) => e.event_type === "step_executed");
  console.log(`  Step-executed audit events: ${stepEvents.length}`);
  expect(stepEvents.length).toBeGreaterThanOrEqual(1);
  expect(stepEvents[0].payload.success).toBe(true);

  if (finalStatus === "failed") {
    expect(stepEvents.length).toBeGreaterThanOrEqual(2);
    const lastStep = stepEvents[stepEvents.length - 1];
    expect(lastStep.payload.success).toBe(false);

    const failureAudit = audit.filter((e: any) => e.event_type === "run_failed");
    expect(failureAudit.length).toBe(1);
    console.log("  Run failure logged in audit: VERIFIED");
  }

  await execPage.close();
});

test("step-result API rejects wrong step_index and transitions atomically on failure", async ({ context }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("API Step Result Test", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);

  const apiPage = await context.newPage();

  // Create the run
  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;
  const runId = run.id;
  console.log(`  Run created: ${runId}, initial step: ${run.current_step_index}`);

  // Call step-result with wrong step_index → expect 409
  const wrongStepResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/step-result`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 999, success: true },
  });
  expect(wrongStepResp.status()).toBe(409);
  const wrongStepBody = await wrongStepResp.json() as any;
  console.log(`  Wrong step_index response: ${wrongStepBody.error.code}`);
  expect(wrongStepBody.error.code).toBe("STEP_INDEX_MISMATCH");

  // Call step-result with correct step_index but success=false
  const failResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/step-result`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, success: false, error: "Element not found: .missing" },
  });
  expect(failResp.ok()).toBeTruthy();
  const failBody = await failResp.json() as any;
  console.log(`  Step-result failure response: ${JSON.stringify(failBody)}`);
  expect(failBody.status).toBe("failed");
  expect(failBody.error_summary).toBe("Element not found: .missing");

  // Verify run is now failed
  const finalResp = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const finalRun = await finalResp.json() as any;
  expect(finalRun.status).toBe("failed");
  expect(finalRun.ended_at).toBeTruthy();

  await apiPage.close();
});
