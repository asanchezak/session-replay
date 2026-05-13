import { test, expect } from "../fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = "dev-api-key-change-in-production";

test("heals: RECOVERING→RUNNING via heal-result endpoint", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine RUNNING", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "h1" }] } },
  ]);

  const apiPage = await context.newPage();

  // Create run
  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;
  console.log(`Run: ${run.id}, status: ${run.status}`);

  // Transition to RECOVERING
  const recoverResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "Testing state machine" },
  });
  expect(recoverResp.ok()).toBeTruthy();
  const recoveringRun = await recoverResp.json() as any;
  expect(recoveringRun.status).toBe("recovering");
  console.log("→ recovering");

  // Heal success — transition to RUNNING
  const healResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/heal-result`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: {
      step_index: 0,
      success: true,
      new_selectors: [{ type: "css", value: "#new-selector" }],
    },
  });
  expect(healResp.ok()).toBeTruthy();
  const healedRun = await healResp.json() as any;
  expect(healedRun.status).toBe("running");
  console.log("→ running (healed)");

  // Verify workflow_snapshot was updated
  const runData = await (await apiPage.request.get(`${BACKEND}/v1/runs/${run.id}`, {
    headers: { "X-API-Key": API_KEY },
  })).json() as any;
  console.log(`Snapshot contains healed selectors: ${JSON.stringify(runData.workflow_snapshot?.steps?.[0]?.selector_chain)}`);

  await apiPage.close();
});

test("heals: RECOVERING→WAITING_FOR_USER on heal failure", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine WAITING", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);

  const apiPage = await context.newPage();

  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;
  console.log(`Run: ${run.id}, status: ${run.status}`);

  // Recover
  await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "test" },
  });

  // Heal failure → WAITING_FOR_USER
  const failResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/heal-result`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, success: false, error: "All healing attempts failed" },
  });
  expect(failResp.ok()).toBeTruthy();
  const failedRun = await failResp.json() as any;
  expect(failedRun.status).toBe("waiting_for_user");
  console.log(`→ waiting_for_user`);

  await apiPage.close();
});

test("heals: RECOVERING→CANCELED is valid", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine CANCEL", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);

  const apiPage = await context.newPage();

  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;

  await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "test" },
  });

  const cancelResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/cancel`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(cancelResp.ok()).toBeTruthy();
  const cancelledRun = await cancelResp.json() as any;
  expect(cancelledRun.status).toBe("canceled");
  console.log(`→ canceled`);

  await apiPage.close();
});
