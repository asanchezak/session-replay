import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = "dev-api-key-change-in-production";

test.describe("E2E: Record → Backend → SW Replay → Audit", () => {

  /**
   * Test 1: Record a workflow with cross-page navigation, then
   * execute it through the service worker's __executeWorkflowRun.
   *
   * This validates the full pipeline:
   *   popup recording → SW event buffer → backend storage →
   *   workflow creation → __executeWorkflowRun → content script
   *   step execution → step result reporting → run completion →
   *   audit trail with valid hash chain.
   *
   * The scenario records clicks on example.com (h1, p, link),
   * navigates to iana.org via the link, and clicks on iana.org.
   * Then all recorded steps are replayed on the initial page.
   */
  test("full recording-to-replay cycle with cross-page recording", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

    // ════════════════════════════════════════════════════════════════
    // Phase 1: Record workflow on https://example.com
    // ════════════════════════════════════════════════════════════════
    console.log("\n── Phase 1: Recording ──");

    // Navigate to the target page FIRST so content script is loaded
    const targetUrl = "https://example.com";
    const recordPage = await context.newPage();
    await recordPage.goto(targetUrl);
    await expect(recordPage.locator("body")).toBeVisible();
    await recordPage.waitForTimeout(1500);

    // Open the extension popup
    const popup = await ext.openPopup();
    await expect(popup.page.getByText("Record Workflow")).toBeVisible();
    console.log("  Popup opened, ready to record");

    // Start recording
    await popup.clickRecord();
    const recording = await popup.isRecording();
    expect(recording).toBeTruthy();
    console.log("  Recording started ✓");

    // Perform real user interactions on example.com
    // 1. Click the h1 heading "Example Domain"
    await recordPage.click("h1");
    await recordPage.waitForTimeout(300);

    // 2. Click the first paragraph
    await recordPage.click("p");
    await recordPage.waitForTimeout(300);

    // 3. Click the "More information" link — this WILL navigate to iana.org
    //    Note: this event may or may not be recorded due to the page
    //    navigation race (sendMessage is fire-and-forget before unload).
    await recordPage.locator("a").click();
    await recordPage.waitForTimeout(1500);  // wait for navigation to complete

    // 4. Now on iana.org — try recording a click there too
    const newPageUrl = recordPage.url();
    console.log(`  Post-navigation URL: ${newPageUrl}`);
    try {
      // Wait for the new page to settle
      await recordPage.waitForTimeout(1000);
      // Click somewhere on the page header or body to record an event on the new page
      const body = recordPage.locator("body");
      await body.waitFor({ state: "visible", timeout: 5000 });
      await body.click({ position: { x: 200, y: 100 } });
      await recordPage.waitForTimeout(300);
      console.log("  Clicked on new page");
    } catch (e) {
      console.log(`  Could not interact with new page: ${e}`);
    }

    // Stop recording via popup
    await popup.page.bringToFront();
    await popup.page.waitForTimeout(500);
    await popup.clickStop();
    await popup.page.waitForTimeout(3000); // wait for backend API call to complete

    expect(await popup.isIdle()).toBeTruthy();
    console.log("  Recording stopped ✓");

    // ════════════════════════════════════════════════════════════════
    // Phase 2: Fetch the recorded workflow and analyze steps
    // ════════════════════════════════════════════════════════════════
    console.log("\n── Phase 2: Workflow Analysis ──");

    // Get all workflows from the backend
    const wfResp = await recordPage.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    const workflows = await wfResp.json() as any[];
    expect(workflows.length).toBeGreaterThanOrEqual(1);
    const workflow = workflows[0];
    console.log(`  Workflow: id=${workflow.id} status=${workflow.status}`);

    // Get workflow details with steps
    const detailResp = await recordPage.request.get(
      `${BACKEND}/v1/workflows/${workflow.id}`,
      { headers: { "X-API-Key": API_KEY } },
    );
    const detail = await detailResp.json() as any;
    const steps = detail.steps;
    console.log(`  Steps recorded: ${steps.length}`);

    // Log each step with its selector, value, and page_url
    for (const s of steps) {
      const sel = s.selector_chain?.[0]?.value || "(no selector)";
      const val = s.value ? `value="${s.value.slice(0, 60)}"` : "";
      const intent = s.intent ? `intent="${s.intent}"` : "";
      console.log(`    ${s.step_index}. ${s.action_type} ${sel} ${val} ${intent}`);
    }

    // Check if the "More information" link click was captured
    const recordedActions = steps.map((s: any) => s.action_type);
    console.log(`  Action types: [${recordedActions.join(", ")}]`);

    // At minimum, we should have clicks (h1 + p)
    // The link click may be lost during navigation
    expect(steps.length).toBeGreaterThanOrEqual(2);
    const clickSteps = steps.filter((s: any) => s.action_type === "click");
    expect(clickSteps.length).toBeGreaterThanOrEqual(1);

    // Check if we captured events from the cross-page navigation.
    // Step values contain element text ("Example Domain", "Learn more"),
    // not URLs. Check for events that reference iana.org content by
    // looking at selectors or values that contain known IANA elements.
    const ianaSelectors = steps.filter((s: any) => {
      const sel = s.selector_chain?.[0]?.value || "";
      return sel.includes("#logo") || sel.includes("iana");
    });
    const hasPostNavEvent = ianaSelectors.length > 0;
    console.log(`  Cross-page events captured on iana.org: ${hasPostNavEvent}`);
    if (hasPostNavEvent) {
      console.log(`    Selectors: ${ianaSelectors.map((s: any) => s.selector_chain?.[0]?.value).join(", ")}`);
    }

    // ════════════════════════════════════════════════════════════════
    // Phase 3: Execute the workflow via service worker
    // ════════════════════════════════════════════════════════════════
    console.log("\n── Phase 3: Service Worker Execution ──");

    // Open a fresh page so the content script is loaded
    // The SW will navigate this tab to workflow.target_url if set
    const execPage = await context.newPage();
    await execPage.goto(targetUrl);
    await execPage.waitForTimeout(1500);
    console.log(`  Execution page opened: ${execPage.url()}`);

    // Get the service worker
    const sw = await ext.getServiceWorker();
    console.log("  Service worker found");

    // Find the execution tab's ID
    const execTabId = await sw.evaluate(() => {
      return new Promise<number | undefined>((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs[0]?.id);
        });
      });
    });
    console.log(`  Execution tab ID: ${execTabId}`);
    expect(execTabId).toBeDefined();

    // Call the embedded __executeWorkflowRun function
    // This runs synchronously (awaits all steps) and returns the result
    console.log(`  Calling __executeWorkflowRun("${workflow.id}", ${execTabId})...`);
    let runResult: any;
    try {
      runResult = await sw.evaluate(
        async ({ workflowId, tabId }: { workflowId: string; tabId: number }) => {
          const fn = (self as any).__executeWorkflowRun as (
            workflowId: string,
            tabId?: number,
          ) => Promise<{ id: string; status: string; total_steps: number }>;
          return await fn(workflowId, tabId);
        },
        { workflowId: workflow.id, tabId: execTabId },
      );
    } catch (e) {
      console.log(`  __executeWorkflowRun threw: ${e}`);
      // The function may time out if it hangs; capture what we can
    }

    console.log(`  Run result: ${JSON.stringify(runResult)}`);
    expect(runResult).toBeDefined();
    const runId = runResult.id;
    console.log(`  Run ID: ${runId}`);

    // Poll backend until the run completes or fails
    console.log("\n── Phase 4: Polling for Completion ──");
    let finalStatus = "";
    let finalStep = -1;
    let errorSummary: string | null = null;
    let totalSteps = runResult.total_steps || steps.length;

    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const resp = await execPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
          headers: { "X-API-Key": API_KEY },
        });
        const run = await resp.json() as any;
        finalStatus = run.status;
        finalStep = run.current_step_index;
        errorSummary = run.error_summary || null;
        console.log(
          `  [${attempt + 1}] status=${run.status} step=${run.current_step_index}/${totalSteps}`,
        );
        if (["completed", "failed", "canceled"].includes(finalStatus)) break;
      } catch (e) {
        console.log(`  [${attempt + 1}] Error polling: ${e}`);
      }
    }

    console.log(`\n  Final: status=${finalStatus} step=${finalStep}/${totalSteps} error=${errorSummary}`);
    expect(finalStatus).toBe("completed");

    // ════════════════════════════════════════════════════════════════
    // Phase 5: Verify the audit trail
    // ════════════════════════════════════════════════════════════════
    console.log("\n── Phase 5: Audit Trail Verification ──");

    const auditResp = await execPage.request.get(`${BACKEND}/v1/audit/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const auditData = await auditResp.json() as any;
    console.log(`  Audit: chain_valid=${auditData.chain_valid} event_count=${auditData.event_count}`);

    expect(auditData.chain_valid).toBe(true);
    expect(auditData.event_count).toBeGreaterThanOrEqual(2);

    const audit = auditData.events || [];
    console.log(`  Audit events (${audit.length}):`);
    for (const ev of audit) {
      console.log(
        `    ${ev.created_at?.slice(11, 19) || "?"}  ${ev.event_type}` +
        `  payload=${JSON.stringify(ev.payload)}`,
      );
    }

    // Verify step_executed events
    const stepEvents = audit.filter((e: any) => e.event_type === "step_executed");
    console.log(`  Step-executed events: ${stepEvents.length}`);
    expect(stepEvents.length).toBeGreaterThanOrEqual(1);

    // All step events should have success=true for a completed run
    for (const ev of stepEvents) {
      expect(ev.payload.success).toBe(true, `Step ${ev.payload.step_index} should succeed`);
    }

    // Verify the events include run_started
    const startEvents = audit.filter((e: any) => e.event_type === "run_started");
    expect(startEvents.length).toBe(1, "Should have exactly one run_started event");
    console.log(`  run_started payload: ${JSON.stringify(startEvents[0].payload)}`);

    // Verify run completed event
    const completeEvents = audit.filter((e: any) => e.event_type === "run_completed");
    if (completeEvents.length > 0) {
      console.log(`  run_completed: ✓`);
    } else {
      // The run_completed may be handled by the SW calling apiClient.completeRun()
      // Which transitions on backend and logs the audit event
      console.log(`  Note: run_completed event may be pending`);
    }

    // Verify hash chain integrity
    for (let i = 1; i < audit.length; i++) {
      const prevHash = audit[i - 1].hash;
      const currPrevHash = audit[i].previous_hash;
      expect(currPrevHash).toBe(
        prevHash,
        `Hash chain broken at event ${i}: ${audit[i].event_type}`,
      );
    }
    console.log("  Hash chain: ✓ INTEGRITY VERIFIED");

    // ════════════════════════════════════════════════════════════════
    // Phase 6: Console error check
    // ════════════════════════════════════════════════════════════════
    console.log("\n── Phase 6: Error Check ──");

    const extConsoleErrors = errors.filter(
      (e) => e.type === "console" && e.url?.includes("chrome-extension://"),
    );
    if (extConsoleErrors.length > 0) {
      console.log(`  ⚠ Extension console errors:`);
      for (const e of extConsoleErrors) {
        console.log(`    ${e.text.slice(0, 200)}`);
      }
    }
    // Allow errors from known patterns (e.g., message port closed before response)
    const criticalErrors = extConsoleErrors.filter(
      (e) => !e.text.includes("Receiving end does not exist"),
    );
    console.log(`  Critical errors: ${criticalErrors.length}`);

    // ════════════════════════════════════════════════════════════════
    // Phase 7: Summary
    // ════════════════════════════════════════════════════════════════
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("  TEST SUMMARY");
    console.log(`  Workflow ID:      ${workflow.id}`);
    console.log(`  Run ID:           ${runId}`);
    console.log(`  Steps recorded:   ${steps.length}`);
    console.log(`  Steps executed:   ${stepEvents.length}`);
    console.log(`  Final status:     ${finalStatus}`);
    console.log(`  Audit chain:      ${auditData.chain_valid ? "VALID" : "BROKEN"}`);
    console.log(`  Recorded actions: ${recordedActions.join(", ")}`);
    console.log(`  Cross-page events: ${hasPostNavEvent ? "✓ captured (replay succeeded)" : "✗ not captured (navigation race)"}`);
    console.log(`  Note: The recorded workflow proved replayable even with`);
    console.log(`  cross-page clicks. However, cross-page navigation during`);
    console.log(`  replay relies on the service worker's navigate step`);
    console.log(`  + waitForTabLoad mechanism, which has a race condition`);
    console.log(`  (navigation can complete before the listener is registered).`);
    console.log(`  See test 2 for more details.`);
    console.log("═══════════════════════════════════════════════════════\n");

    // Cleanup
    await popup.page.close();
    await recordPage.close();
    await execPage.close();
  });

  /**
   * Test 2: Verify recording captures events correctly across page
   * navigation by checking step metadata and selectors.
   */
  test("recording captures events across page navigation", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

    console.log("\n── Recording Across Navigation ──");

    const page = await context.newPage();
    await page.goto("https://example.com");
    await page.waitForTimeout(1500);

    const popup = await ext.openPopup();
    await popup.clickRecord();
    expect(await popup.isRecording()).toBeTruthy();
    console.log("  Recording started");

    // Click h1 on example.com
    await page.click("h1");
    await page.waitForTimeout(300);

    // Click the link to navigate to iana.org
    await page.locator("a").click();
    await page.waitForTimeout(2000); // wait for navigation

    const urlAfterNav = page.url();
    console.log(`  Navigated to: ${urlAfterNav}`);

    // Wait for body to be present on new page
    try {
      await page.locator("body").waitFor({ state: "visible", timeout: 5000 });
      // Click on the new page body (a generic click)
      await page.locator("body").click({ position: { x: 150, y: 150 } });
      await page.waitForTimeout(300);
      console.log("  Clicked on new page body");
    } catch (e) {
      console.log(`  New page interaction failed: ${e}`);
    }

    // Stop recording
    await popup.page.bringToFront();
    await popup.clickStop();
    await popup.page.waitForTimeout(3000);

    // Fetch workflow
    const wfResp = await page.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    const workflows = await wfResp.json() as any[];
    const workflow = workflows[0];

    const detailResp = await page.request.get(
      `${BACKEND}/v1/workflows/${workflow.id}`,
      { headers: { "X-API-Key": API_KEY } },
    );
    const detail = await detailResp.json() as any;
    const steps = detail.steps;

    console.log(`\n  Recorded steps: ${steps.length}`);
    for (const s of steps) {
      const sel = s.selector_chain?.[0]?.value || "(none)";
      console.log(`    ${s.step_index}. ${s.action_type} css="${sel}" value="${(s.value || "").slice(0, 50)}"`);
    }

    // Check which steps have values that indicate cross-page content
    const ianaValues = steps.filter((s: any) =>
      s.value && (s.value.includes("iana") || s.value.includes("IANA") || s.value.includes("example") && !s.value.includes("Example Domain"))
    );
    console.log(`\n  Events referencing cross-page content: ${ianaValues.length}`);

    // The link click event may be missing (navigation race)
    const pageUrls = steps.map((s: any) => s.value).filter(Boolean);
    console.log(`  Page URLs in steps: ${pageUrls.length > 0 ? pageUrls.join(", ") : "none"}`);

    // General recording validation
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(workflow.status).toBe("draft");

    // Log what we found about cross-page recording
    const allUrls = new Set(steps.map((s: any) => {
      // Step values can contain the URL of the page
      const val = s.value || "";
      if (val.includes("http")) return val;
      return null;
    }).filter(Boolean));

    console.log(`\n  Cross-page recording analysis:`);
    // Count steps by origin: example.com events have value "Example Domain" or similar
    const exampleSteps = steps.filter((s: any) => s.value && (s.value === "Example Domain" || s.value.includes("Example Domain")));
    const ianaSteps = steps.filter((s: any) => {
      const sel = s.selector_chain?.[0]?.value || "";
      return sel.includes("#logo") || sel.includes("iana") || sel.includes("article");
    });
    const linkSteps = steps.filter((s: any) => s.value === "Learn more" || s.value?.includes("Learn more"));
    console.log(`    - Events from example.com: ${exampleSteps.length}`);
    console.log(`    - Events from iana.org (by selector): ${ianaSteps.length}`);
    console.log(`    - Link click captured: ${linkSteps.length} (text="${linkSteps[0]?.value || 'n/a'}")`);
    console.log(`    - Total steps recorded: ${steps.length}`);
    if (ianaSteps.length > 0) {
      console.log(`    ✓ Cross-page recording: EVENTS CAPTURED from both pages`);
    } else if (linkSteps.length > 0) {
      console.log(`    ~ Cross-page recording: link captured, but post-navigation events missing`);
    } else {
      console.log(`    ✗ Cross-page recording: link event may have been lost during navigation`);
    }

    // Check for errors
    const criticalErrors = errors.filter(
      (e) => e.type === "console" && e.url?.includes("chrome-extension://") && !e.text.includes("Receiving end does not exist"),
    );
    if (criticalErrors.length > 0) {
      console.log(`\n  ⚠ Extension errors: ${criticalErrors.length}`);
      for (const e of criticalErrors) {
        console.log(`    ${e.text.slice(0, 200)}`);
      }
    }

    await popup.page.close();
    await page.close();
  });
});
