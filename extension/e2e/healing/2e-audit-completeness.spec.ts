import { test, expect } from "../fixtures";
import { serveTestPage, TEST_PAGE_URL, TEST_PAGE_URL_V2, pollRunStatus, getAudit } from "../helpers";
import { DeterministicHealProvider } from "../helpers/heal-provider";

test("heals: audit trail has recovery events with valid hash chain", async ({ context, extensionId, errors }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Heal Audit Test", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "#submit-btn-v1" }] } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();
  await serveTestPage(execPage);

  const healProvider = new DeterministicHealProvider();
  healProvider.addMapping("#submit-btn-v1", "css", "#submit-btn-v2");

  await execPage.goto(TEST_PAGE_URL_V2);
  await execPage.bringToFront();
  await execPage.waitForTimeout(1500);

  const sw = await ext.getServiceWorker();

  // Get tab ID via active tab (URL-pattern query requires host_permissions)
  const tabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.id));
    });
  });
  expect(tabId).toBeDefined();

  // Inject heal override before running
  await healProvider.injectForRun(execPage, "__all__", ["#submit-btn-v1"]);

  const runResult = await sw.evaluate(
    async ({ wfId, tabId }: { wfId: string; tabId: number }) => {
      const fn = (self as any).__executeWorkflowRun;
      return await fn(wfId, tabId);
    },
    { wfId, tabId }
  );
  expect(runResult).toBeDefined();

  await pollRunStatus(execPage, runResult.id);

  const audit = await getAudit(execPage, runResult.id);
  const eventTypes = audit.map((e: any) => e.event_type);
  console.log(`Audit events (${audit.length}): ${eventTypes.join(", ")}`);

  let chainValid = true;
  for (let i = 1; i < audit.length; i++) {
    if (audit[i].previous_hash !== audit[i - 1].hash) {
      chainValid = false;
      console.log(`Hash chain BREAK at index ${i}: ${audit[i].event_type}`);
      break;
    }
  }
  expect(chainValid).toBe(true);
  console.log("Hash chain: INTEGRITY VERIFIED");

  const recoveryAttempts = audit.filter((e: any) => e.event_type === "recovery_attempt");
  const recoverySuccesses = audit.filter((e: any) => e.event_type === "recovery_success");
  console.log(`Recovery attempts: ${recoveryAttempts.length}, successes: ${recoverySuccesses.length}`);

  if (recoveryAttempts.length > 0) {
    expect(recoveryAttempts[0].payload.step_index).toBe(1);
    expect(recoveryAttempts[0].payload.method).toBe("ai");
  }
  if (recoverySuccesses.length > 0) {
    expect(recoverySuccesses[0].payload.step_index).toBe(1);
  }

  const stepEvents = audit.filter((e: any) => e.event_type === "step_executed");
  console.log(`Step events: ${stepEvents.length}`);

  await healProvider.clearAll(execPage);
  await execPage.close();
});
