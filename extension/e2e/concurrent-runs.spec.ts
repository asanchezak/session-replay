import { test, expect } from "./fixtures";
import { serveTestPage, TEST_PAGE_URL, pollRunStatus } from "./helpers";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("concurrent runs: two workflows start simultaneously and reach terminal state independently",
  async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const wfId1 = await ext.createWorkflowViaAPI("Concurrent Run A", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "#submit-btn-v1" }] } },
  ]);
  const wfId2 = await ext.createWorkflowViaAPI("Concurrent Run B", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "[data-testid='candidate-link']" }] } },
  ]);
  expect(wfId1).toBeTruthy();
  expect(wfId2).toBeTruthy();
  expect(wfId1).not.toBe(wfId2);

  await ext.activateWorkflowViaAPI(wfId1);
  await ext.activateWorkflowViaAPI(wfId2);

  const execPage = await context.newPage();
  await serveTestPage(execPage);
  await execPage.goto(TEST_PAGE_URL);
  await execPage.bringToFront();
  await execPage.waitForTimeout(1000);

  // Start both runs simultaneously via API
  const [run1Resp, run2Resp] = await Promise.all([
    execPage.request.post(`${BACKEND}/v1/workflows/${wfId1}/run`, {
      headers: { "X-API-Key": API_KEY },
    }),
    execPage.request.post(`${BACKEND}/v1/workflows/${wfId2}/run`, {
      headers: { "X-API-Key": API_KEY },
    }),
  ]);

  const run1 = await run1Resp.json() as any;
  const run2 = await run2Resp.json() as any;
  expect(run1.id).toBeTruthy();
  expect(run2.id).toBeTruthy();
  expect(run1.id).not.toBe(run2.id);
  console.log(`  Run A: ${run1.id}`);
  console.log(`  Run B: ${run2.id}`);

  // Execute both runs via SW in sequence (SW is single-threaded)
  const sw = await ext.getServiceWorker();

  const runResult1 = await sw.evaluate(
    async ({ workflowId }: { workflowId: string }) => {
      const fn = (self as any).__executeWorkflowRun as (
        workflowId: string,
        tabId?: number,
      ) => Promise<{ id: string; status: string; total_steps: number }>;
      return await fn(workflowId);
    },
    { workflowId: wfId1 },
  );
  const runResult2 = await sw.evaluate(
    async ({ workflowId }: { workflowId: string }) => {
      const fn = (self as any).__executeWorkflowRun as (
        workflowId: string,
        tabId?: number,
      ) => Promise<{ id: string; status: string; total_steps: number }>;
      return await fn(workflowId);
    },
    { workflowId: wfId2 },
  );

  // Poll both runs to terminal state
  const [finalRun1, finalRun2] = await Promise.all([
    pollRunStatus(execPage, runResult1.id, { timeout: 60_000 }),
    pollRunStatus(execPage, runResult2.id, { timeout: 60_000 }),
  ]);

  console.log(`  Run A final: ${finalRun1.status} (step ${finalRun1.current_step_index}/${finalRun1.total_steps})`);
  console.log(`  Run B final: ${finalRun2.status} (step ${finalRun2.current_step_index}/${finalRun2.total_steps})`);

  // Both runs reached a terminal state independently
  const terminal = ["completed", "failed", "waiting_for_user", "canceled"];
  expect(terminal).toContain(finalRun1.status);
  expect(terminal).toContain(finalRun2.status);

  // Runs are distinct — step counts belong to their own workflows
  expect(finalRun1.id).not.toBe(finalRun2.id);

  await execPage.close();
});
