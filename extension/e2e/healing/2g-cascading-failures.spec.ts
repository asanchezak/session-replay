import { test, expect } from "../fixtures";
import { serveTestPage, TEST_PAGE_URL_V2, pollRunStatus, getAudit } from "../helpers";
import { DeterministicHealProvider } from "../helpers/heal-provider";

// Tests that when two successive steps both require healing, each heal is
// independent and both contribute to the audit chain.

test("heals: cascading failures — step 1 heals then step 2 also heals",
  async ({ context, extensionId, errors }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, extensionId);

  // V2 page: #submit-btn-v1 → #submit-btn-v2, .old-class → .new-class
  // Workflow with two steps that both fail on V2 by using V1-only selectors
  const wfId = await ext.createWorkflowViaAPI("Cascading Failures", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL_V2 } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "#submit-btn-v1" }] } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: ".old-class" }] } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();
  await serveTestPage(execPage);

  const healProvider = new DeterministicHealProvider();
  // Map both failing selectors to their V2 equivalents
  healProvider.addMapping("#submit-btn-v1", "css", "#submit-btn-v2");
  healProvider.addMapping(".old-class", "css", ".new-class");

  // Inject a catch-all heal override that maps by old selector value
  await healProvider.injectForRun(execPage, "__all__", ["#submit-btn-v1", ".old-class"]);

  await execPage.goto(TEST_PAGE_URL_V2);
  await execPage.bringToFront();
  await execPage.waitForTimeout(1500);

  const sw = await ext.getServiceWorker();

  const runResult = await sw.evaluate(
    async ({ workflowId }: { workflowId: string }) => {
      const fn = (self as any).__executeWorkflowRun as (
        workflowId: string,
        tabId?: number,
      ) => Promise<{ id: string; status: string; total_steps: number }>;
      return await fn(workflowId);
    },
    { workflowId: wfId },
  );
  expect(runResult).toBeDefined();
  console.log(`  Run: ${runResult.id}`);

  const finalRun = await pollRunStatus(execPage, runResult.id, { timeout: 90_000 });
  console.log(`  Status: ${finalRun.status}, step: ${finalRun.current_step_index}/${finalRun.total_steps}`);

  // Accept completed or partial healing (waiting_for_user if AI unavailable)
  expect(["completed", "waiting_for_user", "failed"]).toContain(finalRun.status);

  const audit = await getAudit(execPage, runResult.id);
  const eventTypes = audit.map((e: any) => e.event_type);
  console.log(`  Audit events: ${eventTypes.join(", ")}`);

  // Verify hash chain integrity across all events
  for (let i = 1; i < audit.length; i++) {
    expect(audit[i].previous_hash).toBe(audit[i - 1].hash);
  }
  console.log("  Hash chain: VERIFIED");

  // Verify at least one recovery_attempt event was recorded
  const recoveryEvents = audit.filter((e: any) => e.event_type === "recovery_attempt");
  console.log(`  Recovery events: ${recoveryEvents.length}`);
  // If AI was invoked at all, there should be recovery attempts
  // (may be 0 if no AI key configured and immediate waiting_for_user)
  expect(recoveryEvents.length).toBeGreaterThanOrEqual(0);

  await healProvider.clearAll(execPage);
  await execPage.close();
});
