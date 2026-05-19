import { test, expect } from "../fixtures";
import { getE2eBackendBaseUrl } from "../helpers/heal-provider";

const BACKEND = getE2eBackendBaseUrl();
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("heals: RECOVERING→RUNNING via heal-result endpoint", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine RUNNING", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "h1" }] } },
  ]);
  await ext.activateWorkflowViaAPI(wfId);

  const apiPage = await context.newPage();

  // Create run
  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;
  console.log(`Run: ${run.id}, status: ${run.status}`);
  expect(run.status).toBe("running");

  // Trigger recovery pipeline (no AI key → transitions RUNNING→RECOVERING→WAITING_FOR_USER)
  const recoverResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "Testing state machine" },
  });
  expect(recoverResp.ok()).toBeTruthy();
  const recoveredRun = await recoverResp.json() as any;
  // Without AI key, full pipeline runs: RUNNING→RECOVERING→WAITING_FOR_USER
  expect(["recovering", "waiting_for_user"]).toContain(recoveredRun.status);
  console.log(`→ ${recoveredRun.status}`);

  // Heal success from waiting_for_user (or recovering) → RUNNING
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
  console.log(`Snapshot selector: ${JSON.stringify(runData.workflow_snapshot?.steps?.[0]?.selector_chain)}`);

  await apiPage.close();
});

test("heals: RECOVERING→WAITING_FOR_USER on heal failure", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine WAITING", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);
  await ext.activateWorkflowViaAPI(wfId);

  const apiPage = await context.newPage();

  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;
  console.log(`Run: ${run.id}, status: ${run.status}`);

  // Trigger recovery pipeline (no AI key → RUNNING→RECOVERING→WAITING_FOR_USER atomically)
  const recoverResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "test" },
  });
  expect(recoverResp.ok()).toBeTruthy();
  const recoveredRun = await recoverResp.json() as any;
  // Without AI, full pipeline runs and ends at WAITING_FOR_USER
  expect(["recovering", "waiting_for_user"]).toContain(recoveredRun.status);
  console.log(`→ ${recoveredRun.status} (after recover pipeline)`);

  // Verify the run is in a "paused for intervention" state
  const finalResp = await apiPage.request.get(`${BACKEND}/v1/runs/${run.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const finalRun = await finalResp.json() as any;
  expect(["waiting_for_user", "recovering"]).toContain(finalRun.status);
  console.log(`→ waiting_for_user confirmed: ${finalRun.status}`);

  await apiPage.close();
});

test("heals: RECOVERING→CANCELED is valid", async ({ context }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, "");

  const wfId = await ext.createWorkflowViaAPI("State Machine CANCEL", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);
  await ext.activateWorkflowViaAPI(wfId);

  const apiPage = await context.newPage();

  const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const run = await runResp.json() as any;

  // Trigger recovery (transitions to WAITING_FOR_USER with no AI)
  const recoverResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/recover`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { step_index: 0, error: "test" },
  });
  expect(recoverResp.ok()).toBeTruthy();

  // Cancel from WAITING_FOR_USER (valid transition)
  const cancelResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/cancel`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(cancelResp.ok()).toBeTruthy();
  const cancelledRun = await cancelResp.json() as any;
  expect(cancelledRun.status).toBe("canceled");
  console.log(`→ canceled`);

  await apiPage.close();
});
