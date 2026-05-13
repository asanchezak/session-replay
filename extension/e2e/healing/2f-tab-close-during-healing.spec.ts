import { test, expect } from "../fixtures";
import { serveTestPage, TEST_PAGE_URL, pollRunStatus } from "../helpers";
import { DeterministicHealProvider } from "../helpers/heal-provider";

test("heals: tab close during healing handled gracefully", async ({ context, extensionId, errors }) => {
  const ext = new (await import("../page-objects")).ExtensionHelper(context, extensionId);

  const wfId = await ext.createWorkflowViaAPI("Heal Tab Close", [
    { event_type: "navigate", payload: { url: TEST_PAGE_URL } },
    { event_type: "click", payload: { selector_chain: [{ type: "css", value: "#submit-btn-v1" }] } },
  ]);
  expect(wfId).toBeTruthy();

  const execPage = await context.newPage();
  await serveTestPage(execPage);

  const healProvider = new DeterministicHealProvider();
  healProvider.addMapping("#submit-btn-v1", "css", "#submit-btn-v2");
  await healProvider.injectForRun(execPage, "__all__", ["#submit-btn-v1"]);

  await execPage.goto(TEST_PAGE_URL);
  await execPage.waitForTimeout(1500);

  const sw = await ext.getServiceWorker();

  const tabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ url: "http://sr-test.local/*" }, (tabs) => resolve(tabs[0]?.id));
    });
  });
  expect(tabId).toBeDefined();

  const runPromise = sw.evaluate(
    async ({ wfId, tabId }: { wfId: string; tabId: number }) => {
      const fn = (self as any).__executeWorkflowRun;
      return await fn(wfId, tabId);
    },
    { wfId, tabId }
  );

  await new Promise((r) => setTimeout(r, 300));
  await execPage.close();

  const runResult = await runPromise;
  console.log(`Run result: ${JSON.stringify(runResult)}`);
  expect(runResult.status).toBe("failed");

  try { await pollRunStatus(execPage, runResult.id); } catch {
    console.log("Backend poll failed (expected after tab close)");
  }

  try { await healProvider.clearAll(execPage); } catch { /* page closed */ }
});
