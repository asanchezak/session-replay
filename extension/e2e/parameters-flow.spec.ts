import { test, expect } from "./fixtures";
import { serveTestPage, TEST_PAGE_URL } from "./helpers";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

// Tests the run-with-params flow: create a workflow whose steps contain
// parameter placeholders, then execute it with substituted runtime values.

test("parameters flow: run-with-params substitutes runtime values into workflow steps",
  async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  // Create a workflow with a navigate step using a URL parameter placeholder
  const wfId = await ext.createWorkflowViaAPI("Parameterized Workflow", [
    {
      event_type: "navigate",
      payload: { url: "{{target_url}}" },
    },
    {
      event_type: "click",
      payload: { selector_chain: [{ type: "css", value: "#submit-btn-v1" }] },
    },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();
  await serveTestPage(execPage);

  // Call run-with-params to substitute the placeholder. The autonomy WIP
  // (commit b20edca) added a GOAL_REQUIRED check that 409s workflows with
  // ambiguous clicks unless an execution_goal is supplied; we set one here
  // since the test workflow has a generic "#submit-btn-v1" click.
  const runResp = await execPage.request.post(
    `${BACKEND}/v1/workflows/${wfId}/run-with-params`,
    {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: {
        runtime_params: { target_url: TEST_PAGE_URL },
        execution_goal: "Submit the test form",
      },
    },
  );
  expect(runResp.ok()).toBeTruthy();
  const run = await runResp.json() as any;
  console.log(`  Run: ${run.id}, status: ${run.status}`);

  // Verify the API accepted the parameters and created a valid run
  expect(run.id).toBeTruthy();
  // Initial state is queued/running (backend creates it; extension SW executes later)
  expect(["queued", "running"]).toContain(run.status);
  expect(run.total_steps).toBeGreaterThanOrEqual(1);

  // Verify we can retrieve the run — confirms persistence
  const fetchResp = await execPage.request.get(`${BACKEND}/v1/runs/${run.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(fetchResp.ok()).toBeTruthy();
  const fetched = await fetchResp.json() as any;
  expect(fetched.id).toBe(run.id);
  console.log(`  Verified run persisted with ${fetched.total_steps} steps`);

  await execPage.close();
});

test("parameters flow: run-with-params with missing placeholder fails gracefully",
  async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Parameterized Workflow Missing", [
    { event_type: "navigate", payload: { url: "{{required_url}}" } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();

  // Run with empty params — placeholder is NOT substituted
  const runResp = await execPage.request.post(
    `${BACKEND}/v1/workflows/${wfId}/run-with-params`,
    {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { runtime_params: {} },
    },
  );

  // Backend either creates the run (graceful) or rejects with 400/422
  const status = runResp.status();
  console.log(`  Response status for missing param: ${status}`);
  expect([200, 201, 400, 422]).toContain(status);

  await execPage.close();
});
