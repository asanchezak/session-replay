import { test, expect } from "../fixtures";
import { serveTestPage, TEST_PAGE_URL, pollRunStatus, getAudit, setAiApiKey } from "../helpers";

test("heals: deterministic failure path (no AI key)", async ({ context, extensionId, errors }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, extensionId);

  // Create workflow with a step that will fail (non-existent selector)
  const wfId = await ext.createWorkflowViaAPI("Heal Deterministic Failure", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "#non-existent-element" }] } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();
  await serveTestPage(execPage);
  await execPage.goto(TEST_PAGE_URL);
  await execPage.bringToFront();
  await execPage.waitForTimeout(1500);

  // Ensure no AI key
  const sw = await ext.getServiceWorker();
  await setAiApiKey(sw, "");

  // Get tab ID via active tab (URL-pattern query requires host_permissions)
  const tabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.id));
    });
  });
  expect(tabId).toBeDefined();

  // Run workflow
  const runResult = await sw.evaluate(
    async ({ wfId, tabId }: { wfId: string; tabId: number }) => {
      const fn = (self as any).__executeWorkflowRun;
      return await fn(wfId, tabId);
    },
    { wfId, tabId }
  );
  expect(runResult).toBeDefined();

  const finalRun = await pollRunStatus(execPage, runResult.id);
  console.log(`Status: ${finalRun.status}, step: ${finalRun.current_step_index}, error: ${finalRun.error_summary}`);

  // No AI, step can't be healed — run is in waiting_for_user for human review
  expect(["failed", "waiting_for_user"]).toContain(finalRun.status);
  expect(finalRun.current_step_index).toBe(1);

  // Audit should have run_recovering event
  const audit = await getAudit(execPage, runResult.id);
  const eventTypes = audit.map((e: any) => e.event_type);
  console.log(`Audit events: ${eventTypes.join(", ")}`);
  expect(eventTypes).toContain("run_recovering");

  await execPage.close();
});
