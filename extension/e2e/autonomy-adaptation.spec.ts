import { test, expect } from "./fixtures";
import { ExtensionHelper } from "./page-objects";

const BACKEND = process.env.BACKEND_OVERRIDE || "http://localhost:8091";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_PAGE_URL = "http://sr-autonomy.local/results";

// Mocks a Google-style search result page where the result anchor's id is
// randomised on every load — exactly the failure mode that broke run
// 0dd2bccd. The recorded blueprint has the stale id, but the visible text
// "Indeed: Job Search" is stable. The fix should detect the fragile selector,
// consult the LLM, and adapt to a stable selector OR navigate directly.
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
    // Simulate Google's session-specific id behaviour
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

test("autonomy: agent adapts past session-specific id and clicks stable element",
  async ({ context, extensionId, errors }) => {
    // TODO: POST /v1/runs creates a queued run but there is no backend run executor
    // that picks up queued runs. The extension SW executes runs client-side via
    // __executeWorkflowRun; a server-side agent scheduler is not yet implemented.
    test.fixme(true, "Requires backend run executor / agent scheduler (not yet implemented)");
    test.setTimeout(180000);
    const ext = new ExtensionHelper(context, extensionId);

    const testPage = await context.newPage();
    for (const p of context.pages()) if (p !== testPage) await p.close().catch(() => {});
    await testPage.bringToFront();

    await testPage.route("**/sr-autonomy.local/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/html", body: MOCK_GOOGLE_HTML });
    });
    await testPage.goto(TEST_PAGE_URL);
    await expect(testPage.getByText("Search results for")).toBeVisible();
    console.log("  [1/4] Test page loaded with randomized session id");

    // Build a workflow whose first step references a session-specific id that
    // no longer exists on the page, plus a stable text fallback.
    const apiPage = await context.newPage();
    const recordResp = await apiPage.request.post(`${BACKEND}/v1/workflows/record`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: {
        name: "autonomy adaptation test",
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
                intent: "Click the \"Indeed: Job Search\" result",
              },
            },
          },
        ],
      },
    });
    expect(recordResp.ok()).toBeTruthy();
    const wfId = (await recordResp.json()).id;
    console.log(`  [2/4] Workflow created: ${wfId}`);

    // Trigger the run via POST /v1/runs (doesn't require workflow.status="active")
    const runResp = await apiPage.request.post(`${BACKEND}/v1/runs`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { workflow_id: wfId },
    });
    expect(runResp.ok()).toBeTruthy();
    const runId = (await runResp.json()).id;
    console.log(`  [3/4] Run started: ${runId}`);

    // Wait for the run to terminate (completed / failed / waiting_for_user)
    let status = "running";
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120000) {
      const resp = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
        headers: { "X-API-Key": API_KEY },
      });
      const body = await resp.json();
      status = body.status;
      if (!["queued", "running", "recovering"].includes(status)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`  [4/4] Final run status: ${status}`);

    // Pull the agent decisions to make the adaptation evidence explicit
    const decisionsResp = await apiPage.request.get(
      `${BACKEND}/v1/agent/${runId}/decisions`,
      { headers: { "X-API-Key": API_KEY } },
    );
    const decisions = await decisionsResp.json() as Array<{ payload: Record<string, unknown> }>;
    console.log(`  Agent decisions: ${decisions.length}`);
    for (const d of decisions.slice(0, 10)) {
      const p = d.payload as { decision?: string; reasoning?: string; confidence?: number };
      console.log(`    - ${p.decision} (conf ${p.confidence}): ${p.reasoning?.slice(0, 120)}`);
    }

    // The autonomy fix should keep the run from hard-failing on a session id.
    // Either: 1) run completes, 2) at least one ADAPT decision occurred.
    const adapted = decisions.some(d => {
      const p = d.payload as { decision?: string };
      return p.decision === "ADAPT" || p.decision === "SKIP";
    });
    const okBanner = await testPage.evaluate(() => document.body.getAttribute("data-ok"));

    expect(
      status === "completed" || adapted || okBanner === "1",
      `Expected adaptation evidence: status=${status}, adapted=${adapted}, okBanner=${okBanner}`,
    ).toBeTruthy();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);

    await apiPage.close();
  });
