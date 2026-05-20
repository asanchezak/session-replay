import { test, expect } from "../fixtures";
import { serveTestPage, TEST_PAGE_URL_V2, pollRunStatus, getAudit } from "../helpers";
import { DeterministicHealProvider } from "../helpers/heal-provider";

test("heals: fallback methods recover before AI is needed", async ({ context, extensionId, errors }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Heal Fallback Methods", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL_V2 } },
    {
      event_type: "click",
      payload: {
        selector_chain: [{ type: "css", value: ".old-class" }],
        methods: [
          { action_type: "click", selector_chain: [{ type: "css", value: ".new-class" }] },
        ],
      },
    },
    { event_type: "click", payload: { selector_chain: [{ type: "text", value: "Some text here" }] } },
  ]);
  expect(wfId).toBeTruthy();
  await ext.activateWorkflowViaAPI(wfId);

  const execPage = await context.newPage();
  await serveTestPage(execPage);

  // Inject empty heal override so AI returns nothing (method should succeed first)
  const healProvider = new DeterministicHealProvider({
    selector: "",
    fallback_selectors: [],
    confidence: 0.0,
    explanation: "Mock empty",
  });
  await healProvider.injectForRun(execPage, "__all__", []);

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

  const runResult = await sw.evaluate(
    async ({ wfId, tabId }: { wfId: string; tabId: number }) => {
      const fn = (self as any).__executeWorkflowRun;
      return await fn(wfId, tabId);
    },
    { wfId, tabId }
  );
  expect(runResult).toBeDefined();

  const finalRun = await pollRunStatus(execPage, runResult.id);
  console.log(`Status: ${finalRun.status}, step: ${finalRun.current_step_index}/3`);

  // Fallback methods should recover — accept completed or waiting for partial recovery
  expect(["completed", "waiting_for_user"]).toContain(finalRun.status);

  const audit = await getAudit(execPage, runResult.id);
  const eventTypes = audit.map((e: any) => e.event_type);
  console.log(`Audit events: ${eventTypes.join(", ")}`);
  // Recovery WIP renamed run_recovering -> recovery_cycle; the autonomy work
  // can also let fallback methods succeed without entering recovery at all
  // (the fallback's job is to *prevent* recovery being needed). Accept any
  // of the three outcomes.
  const hadRecovery = eventTypes.includes("recovery_cycle")
    || eventTypes.includes("run_recovering");
  const completedCleanly = eventTypes.includes("run_completed");
  expect(hadRecovery || completedCleanly).toBe(true);

  await healProvider.clearAll(execPage);
  await execPage.close();
});
