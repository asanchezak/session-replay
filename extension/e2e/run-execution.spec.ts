import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = "dev-api-key-change-in-production";

test("create workflow via API and run it", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  // Create a workflow via the record API
  const wfId = await ext.createWorkflowViaAPI("E2E Run Test", [
    {
      event_type: "navigate",
      payload: { url: "https://example.com" },
    },
    {
      event_type: "click",
      payload: { target: { selector: "h1" } },
    },
  ]);
  expect(wfId).toBeTruthy();
  console.log(`  Created workflow: ${wfId}`);

  // Run it
  const runId = await ext.runWorkflowViaAPI(wfId);
  expect(runId).toBeTruthy();
  console.log(`  Created run: ${runId}`);

  // Verify status is "running"
  const status = await ext.getRunStatus(runId);
  expect(status).toBe("running");

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("run appears in dashboard after creation", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Dashboard Run Test", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
  ]);
  const runId = await ext.runWorkflowViaAPI(wfId);
  console.log(`  Created run: ${runId}`);

  // Check via API
  const page = await context.newPage();
  const runsResp = await page.request.get(`${BACKEND}/v1/runs`, {
    headers: { "X-API-Key": API_KEY },
  });
  const runs = await runsResp.json() as any[];
  const ourRun = runs.find((r: any) => r.id === runId);
  expect(ourRun).toBeDefined();
  expect(ourRun.status).toBe("running");

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("advance step through API", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Advance Step Test", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { target: { selector: "h1" } } },
    { event_type: "click", payload: { target: { selector: "p" } } },
  ]);
  const runId = await ext.runWorkflowViaAPI(wfId);

  // Advance step
  await ext.advanceStep(runId);

  const status = await ext.getRunStatus(runId);
  expect(status).toBe("running");

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("complete workflow lifecycle via API", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Lifecycle Test", [
    { event_type: "navigate", payload: { url: "https://example.com" } },
    { event_type: "click", payload: { target: { selector: "h1" } } },
  ]);
  const runId = await ext.runWorkflowViaAPI(wfId);

  // Advance through all steps
  await ext.advanceStep(runId);
  const page = await context.newPage();

  // Mark complete
  const completeResp = await page.request.post(`${BACKEND}/v1/runs/${runId}/complete`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(completeResp.ok()).toBeTruthy();

  const finalStatus = await ext.getRunStatus(runId);
  console.log(`  Final run status: ${finalStatus}`);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
