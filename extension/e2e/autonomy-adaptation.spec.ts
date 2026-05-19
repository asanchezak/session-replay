import { test, expect } from "./fixtures";
import { ExtensionHelper } from "./page-objects";

const BACKEND = process.env.BACKEND_OVERRIDE || "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_PAGE_URL = "http://sr-autonomy.local/results";

const MOCK_GOOGLE_HTML = `<!DOCTYPE html>
<html>
<head><title>indeed.com - Google Search</title></head>
<body style="font-family: Arial; padding: 24px;">
  <h1>Search results for "indeed.com"</h1>
  <div class="result">
    <a id="STALE_REPLACED_AT_LOAD" href="https://www.indeed.com" data-action="indeed">
      <h3>Indeed: Job Search</h3>
    </a>
    <div>https://www.indeed.com</div>
    <div>The world's largest job site.</div>
  </div>
  <div id="ok-banner" style="display:none;color:green;font-size:20px;margin-top:24px">
    SUCCESS: Indeed result clicked
  </div>
  <script>
    document.querySelector('[data-action="indeed"]').id =
      '_' + Math.random().toString(36).slice(2, 22) + '_' + Math.floor(Math.random() * 100);
    document.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        if (a.dataset.action === 'indeed') {
          document.getElementById('ok-banner').style.display = 'block';
          document.body.setAttribute('data-ok', '1');
        }
      });
    });
  </script>
</body>
</html>`;

test("autonomy adaptation: service worker executes ADAPT decision against a randomized selector", async ({ context, extensionId, errors }) => {
  test.setTimeout(180000);
  const ext = new ExtensionHelper(context, extensionId);

  const page = await context.newPage();
  await page.route("**/sr-autonomy.local/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: MOCK_GOOGLE_HTML });
  });
  await page.goto(TEST_PAGE_URL);
  await expect(page.getByText("Search results for")).toBeVisible();

  const workflowResp = await page.request.post(`${BACKEND}/v1/workflows/record`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: {
      name: `autonomy adaptation ${Date.now()}`,
      target_url: TEST_PAGE_URL,
      events: [
        {
          event_type: "click",
          payload: {
            target: {
              selector: "#_StaleRecordedSessionId_99",
              selector_chain: [
                { type: "css", value: "#_StaleRecordedSessionId_99", score: 0.8 },
                { type: "text", value: "Indeed: Job Search", score: 0.7 },
              ],
              intent: "Click Indeed result",
            },
          },
        },
      ],
    },
  });
  expect(workflowResp.ok()).toBeTruthy();
  const wfId = (await workflowResp.json()).id as string;

  await ext.activateWorkflowViaAPI(wfId);

  const sw = await ext.getServiceWorker();
  await sw.evaluate(({ apiBaseUrl, apiKey }) => {
    return chrome.storage.session.set({ apiBaseUrl, apiKey });
  }, { apiBaseUrl: `${BACKEND}/v1`, apiKey: API_KEY });

  let pollCount = 0;
  let adaptSeen = false;
  await context.route(`${BACKEND}/v1/agent/*/poll`, async (route) => {
    pollCount += 1;
    if (pollCount === 1) {
      adaptSeen = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          decision: "ADAPT",
          confidence: 0.92,
          reasoning: "Session-specific id is stale; use text anchor",
          command: {
            action: "click",
            target: null,
            value: null,
            selector_chain: [{ type: "text", value: "Indeed: Job Search" }],
            intent: "Click Indeed result",
            methods: [],
            timeout_ms: 15000,
            success_condition: null,
          },
          next_step_index: 0,
          pause_reason: null,
          requires_human: false,
          plan_updates: [],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        decision: "COMPLETED",
        confidence: 0.99,
        reasoning: "Goal achieved",
        command: null,
        next_step_index: null,
        pause_reason: null,
        requires_human: false,
        plan_updates: [],
      }),
    });
  });

  await context.route(`${BACKEND}/v1/agent/*/result`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        decision: null,
        next_step_index: 1,
        should_poll: true,
      }),
    });
  });

  await page.bringToFront();
  await page.waitForTimeout(400);

  const tabId = await sw.evaluate(() => {
    return new Promise<number | undefined>((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]?.id));
    });
  });
  expect(tabId).toBeDefined();

  const runResult = await sw.evaluate(async ({ workflowId, targetTabId }) => {
    const fn = (self as unknown as { __executeAgentRun?: (wf: string, tab?: number, goal?: string, params?: Record<string, unknown>) => Promise<{ id: string; status: string; total_steps: number }> }).__executeAgentRun;
    if (!fn) throw new Error("__executeAgentRun not exposed");
    return fn(workflowId, targetTabId, "Click Indeed result", {});
  }, { workflowId: wfId, targetTabId: tabId });

  expect(runResult.status).toBe("completed");
  expect(adaptSeen).toBe(true);

  const okBanner = await page.evaluate(() => document.body.getAttribute("data-ok"));
  expect(okBanner).toBe("1");

  expect(errors.filter((e) => e.type === "console")).toHaveLength(0);

  await context.unroute(`${BACKEND}/v1/agent/*/poll`);
  await context.unroute(`${BACKEND}/v1/agent/*/result`);
  await page.close();
});
