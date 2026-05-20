import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

function asRunArray(body: unknown): any[] {
  if (Array.isArray(body)) return body;
  if (
    body
    && typeof body === "object"
    && Array.isArray((body as { runs?: unknown[] }).runs)
  ) {
    return (body as { runs: unknown[] }).runs as any[];
  }
  return [];
}

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
  const runsBody = await runsResp.json().catch(() => null);
  const runs = asRunArray(runsBody);
  expect(
    runsResp.ok() && runs.length >= 0,
    `Unexpected runs response status=${runsResp.status()} body=${JSON.stringify(runsBody)}`,
  ).toBeTruthy();
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
  if (!completeResp.ok()) {
    // The run may already be terminal before /complete is called.
    const currentResp = await page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const currentBody = await currentResp.json().catch(() => null);
    const current = (currentBody || {}) as { status?: string };
    expect(
      current.status,
      `Expected terminal run status after non-OK /complete, got status=${currentResp.status()} body=${JSON.stringify(currentBody)}`,
    ).toBe("completed");
  }

  const finalStatus = await ext.getRunStatus(runId);
  console.log(`  Final run status: ${finalStatus}`);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
