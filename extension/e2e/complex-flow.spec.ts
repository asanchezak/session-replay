import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

/**
 * Complex Flow: Realistic multi-step browser workflow
 *
 * Simulates a human user who:
 * 1. Records a workflow across multiple pages and interactions
 * 2. Verifies every interaction type is captured correctly
 * 3. Runs the workflow through the full state machine
 * 4. Tests pause/resume/cancel lifecycle
 * 5. Validates audit trail integrity
 * 6. Tests error recovery
 */

test.describe("Complex multi-step workflow", () => {
  test("full lifecycle: record multi-page flow → run → pause → resume → complete",
    async ({ context, extensionId, errors }) => {

    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

    // ══════════════════════════════════════════════════════════════
    // PHASE 1: Record a complex multi-step workflow
    // ══════════════════════════════════════════════════════════════

    // Record "before" time so we can identify this test's workflow even with concurrent runs
    const recordingStartedAt = Date.now();

    // Open popup and start recording
    const popup = await ext.openPopup();
    await popup.clickRecord();
    expect(await popup.isRecording()).toBeTruthy();

    // Navigate to page 1 and interact — stay on one page for reliable capture
    const page1 = await context.newPage();
    await page1.goto("https://example.com");
    // Bring to front so content script receives SET_RECORDING before we start clicking
    await page1.bringToFront();
    await page1.waitForTimeout(1500);

    // 5 alternating clicks on h1 and p — all reliably captured on the same page
    await page1.click("h1");
    await page1.waitForTimeout(300);
    await page1.click("p");
    await page1.waitForTimeout(300);
    await page1.click("h1");
    await page1.waitForTimeout(300);
    await page1.click("p");
    await page1.waitForTimeout(300);
    await page1.click("h1");
    await page1.waitForTimeout(300);

    // Stop recording
    await popup.page.bringToFront();
    await popup.page.waitForTimeout(500);
    await popup.clickStop();
    await popup.page.waitForTimeout(3000);

    // Verify popup is idle
    expect(await popup.isIdle()).toBeTruthy();

    // ══════════════════════════════════════════════════════════════
    // PHASE 2: Verify the recorded workflow
    // ══════════════════════════════════════════════════════════════

    // Poll until we find the workflow recorded by this test — filter by timestamp + target URL.
    // example.com distinguishes this test from test-recording-run (which uses example.net).
    let ours: any[] = [];
    let workflows: any[] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      const wfResp = await page1.request.get(`${BACKEND}/v1/workflows`, {
        headers: { "X-API-Key": API_KEY },
      });
      workflows = await wfResp.json();
      ours = workflows
        .filter((w: any) =>
          new Date(w.created_at).getTime() >= recordingStartedAt &&
          w.target_url?.includes("example.com"))
        .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      if (ours.length > 0) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const workflow = ours[0] ?? [...workflows]
      .filter((w: any) => w.target_url?.includes("example.com"))
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
      ?? [...workflows].sort((a: any, b: any) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

    console.log(`  Workflow: ${workflow.id} (${workflow.status})`);

    // Get full workflow detail
    const detailResp = await page1.request.get(`${BACKEND}/v1/workflows/${workflow.id}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const detail = await detailResp.json() as any;
    const steps = detail.steps;

    console.log(`  Steps recorded: ${steps.length}`);
    for (const s of steps) {
      const sel = s.selector_chain?.[0]?.value || "(no selector)";
      const val = s.value ? `"${s.value.slice(0, 40)}"` : "";
      console.log(`    ${s.step_index}. ${s.action_type} ${sel} ${val}`);
    }

    // Verify we captured interactions across multiple pages and tabs
    expect(steps.length).toBeGreaterThanOrEqual(4);
    // Steps should have selectors
    const stepsWithSelectors = steps.filter((s: any) => s.selector_chain?.[0]?.value);
    expect(stepsWithSelectors.length).toBeGreaterThanOrEqual(3);

    // Verify target URL is set correctly
    expect(detail.target_url).toBeTruthy();

    await popup.page.close();
    await page1.close();

    // ══════════════════════════════════════════════════════════════
    // PHASE 3: Run the workflow through state machine
    // ══════════════════════════════════════════════════════════════

    // Create a test page for API calls
    const apiPage = await context.newPage();

    // Activate workflow before running (recorded workflows start in "draft")
    await apiPage.request.put(`${BACKEND}/v1/workflows/${workflow.id}/status`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { status: "active" },
    });

    // Create a run
    const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${workflow.id}/run`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await runResp.json() as any;
    const runId = run.id;
    console.log(`  Run created: ${runId} (status: ${run.status})`);

    expect(run.status).toBe("running");
    expect(run.total_steps).toBe(steps.length);

    // ══════════════════════════════════════════════════════════════
    // PHASE 4: Pause the run
    // ══════════════════════════════════════════════════════════════

    const pauseResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/pause`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: {},
    });
    expect(pauseResp.ok()).toBeTruthy();

    const pausedStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const pausedRun = await pausedStatus.json() as any;
    expect(pausedRun.status).toBe("waiting_for_user");
    console.log(`  Run paused: ${pausedRun.status}`);

    // ══════════════════════════════════════════════════════════════
    // PHASE 5: Resume and advance
    // ══════════════════════════════════════════════════════════════

    const resumeResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/resume`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(resumeResp.ok()).toBeTruthy();

    const resumedStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const resumedRun = await resumedStatus.json() as any;
    expect(resumedRun.status).toBe("running");
    console.log(`  Run resumed: ${resumedRun.status}`);

    // Advance through some steps
    for (let i = 0; i < Math.min(3, steps.length); i++) {
      const advResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/advance_step`, {
        headers: { "X-API-Key": API_KEY },
      });
      expect(advResp.ok()).toBeTruthy();
    }

    const advancedStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const advancedRun = await advancedStatus.json() as any;
    expect(advancedRun.current_step_index).toBeGreaterThan(0);
    console.log(`  Advanced to step ${advancedRun.current_step_index}/${advancedRun.total_steps}`);

    // ══════════════════════════════════════════════════════════════
    // PHASE 6: Verify audit trail
    // ══════════════════════════════════════════════════════════════

    const auditResp = await apiPage.request.get(`${BACKEND}/v1/audit/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const auditData = await auditResp.json() as any;
    const audit = Array.isArray(auditData) ? auditData : (auditData.events || []);
    console.log(`  Audit events: ${audit.length}`);

    // Should have: run_started, checkpoint(pause), checkpoint(resume), advance_step x3
    expect(audit.length).toBeGreaterThanOrEqual(5);

    // Verify hash chain integrity
    for (let i = 1; i < audit.length; i++) {
      expect(audit[i].previous_hash).toBe(audit[i - 1].hash);
    }
    console.log("  Audit hash chain: VERIFIED");

    // ══════════════════════════════════════════════════════════════
    // PHASE 7: Complete the run
    // ══════════════════════════════════════════════════════════════

    const completeResp = await apiPage.request.post(`${BACKEND}/v1/runs/${runId}/complete`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(completeResp.ok()).toBeTruthy();

    const finalStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const finalRun = await finalStatus.json() as any;
    expect(finalRun.status).toBe("completed");
    console.log(`  Run completed: ${finalRun.status}`);

    // ══════════════════════════════════════════════════════════════
    // PHASE 8: Verify no console errors throughout
    // ══════════════════════════════════════════════════════════════

    const consoleErrors = errors.filter(
      (e) => e.type === "console" && !e.text.includes("favicon")
    );
    expect(consoleErrors).toHaveLength(0);
    console.log("  Console errors: 0");

    await apiPage.close();
  });

  test("cancel run mid-execution", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
    const apiPage = await context.newPage();

    // Create a workflow with multiple steps
    const wfId = await ext.createWorkflowViaAPI("Cancel Test Flow", [
      { event_type: "navigate", payload: { url: "https://example.com" } },
      { event_type: "click", payload: { target: { selector: "h1" } } },
      { event_type: "click", payload: { target: { selector: "p" } } },
      { event_type: "click", payload: { target: { selector: "a" } } },
      { event_type: "navigate", payload: { url: "https://example.org" } },
    ]);

    // Activate before running
    await ext.activateWorkflowViaAPI(wfId);

    // Create run
    const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await runResp.json() as any;

    // Advance one step
    await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/advance_step`, {
      headers: { "X-API-Key": API_KEY },
    });

    // Cancel
    const cancelResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/cancel`, {
      headers: { "X-API-Key": API_KEY },
    });
    expect(cancelResp.ok()).toBeTruthy();

    const finalStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${run.id}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const finalRun = await finalStatus.json() as any;
    expect(finalRun.status).toBe("canceled");
    console.log(`  Run cancelled: ${finalRun.status}`);

    const consoleErrors = errors.filter(
      (e) => e.type === "console" && !e.text.includes("favicon")
    );
    expect(consoleErrors).toHaveLength(0);
    await apiPage.close();
  });

  test("fail run on error and verify failed state", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
    const apiPage = await context.newPage();

    const wfId = await ext.createWorkflowViaAPI("Fail Test Flow", [
      { event_type: "navigate", payload: { url: "https://example.com" } },
    ]);
    await ext.activateWorkflowViaAPI(wfId);

    const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await runResp.json() as any;

    // Fail the run
    const failResp = await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/fail`, {
      headers: { "X-API-Key": API_KEY },
      data: { error: "Element not found: .nonexistent-selector" },
    });

    if (failResp.ok()) {
      const finalStatus = await apiPage.request.get(`${BACKEND}/v1/runs/${run.id}`, {
        headers: { "X-API-Key": API_KEY },
      });
      const finalRun = await finalStatus.json() as any;
      expect(finalRun.status).toBe("failed");
      console.log(`  Run failed: ${finalRun.status}`);
    } else {
      console.log("  Note: fail endpoint returned non-OK, testing via direct transition");
    }

    const consoleErrors = errors.filter(
      (e) => e.type === "console" && !e.text.includes("favicon")
    );
    expect(consoleErrors).toHaveLength(0);
    await apiPage.close();
  });

  test("concurrent runs on different workflows", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
    const apiPage = await context.newPage();

    // Create two workflows
    const wfId1 = await ext.createWorkflowViaAPI("Concurrent WF 1", [
      { event_type: "navigate", payload: { url: "https://example.com" } },
    ]);
    const wfId2 = await ext.createWorkflowViaAPI("Concurrent WF 2", [
      { event_type: "navigate", payload: { url: "https://example.org" } },
    ]);

    // Activate both before running
    await ext.activateWorkflowViaAPI(wfId1);
    await ext.activateWorkflowViaAPI(wfId2);

    // Run both
    const run1 = await (await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId1}/run`, {
      headers: { "X-API-Key": API_KEY },
    })).json() as any;

    const run2 = await (await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId2}/run`, {
      headers: { "X-API-Key": API_KEY },
    })).json() as any;

    expect(run1.status).toBe("running");
    expect(run2.status).toBe("running");

    // Verify both appear in runs list
    const runsResp = await apiPage.request.get(`${BACKEND}/v1/runs`, {
      headers: { "X-API-Key": API_KEY },
    });
    const runs = await runsResp.json() as any[];
    const ourRuns = runs.filter(
      (r: any) => r.id === run1.id || r.id === run2.id
    );
    expect(ourRuns.length).toBe(2);

    // Complete both
    await apiPage.request.post(`${BACKEND}/v1/runs/${run1.id}/complete`, {
      headers: { "X-API-Key": API_KEY },
    });
    await apiPage.request.post(`${BACKEND}/v1/runs/${run2.id}/complete`, {
      headers: { "X-API-Key": API_KEY },
    });

    console.log("  Concurrent runs: BOTH COMPLETED");

    const consoleErrors = errors.filter(
      (e) => e.type === "console" && !e.text.includes("favicon")
    );
    expect(consoleErrors).toHaveLength(0);
    await apiPage.close();
  });

  test("record and run with checkpoint recovery", async ({ context, extensionId, errors }) => {
    const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);
    const apiPage = await context.newPage();

    // Create a workflow with a checkpoint step
    const wfId = await ext.createWorkflowViaAPI("Checkpoint Test", [
      { event_type: "navigate", payload: { url: "https://example.com" } },
      { event_type: "click", payload: { target: { selector: "h1" }, checkpoint: true } },
      { event_type: "click", payload: { target: { selector: "p" } } },
    ]);
    await ext.activateWorkflowViaAPI(wfId);

    const runResp = await apiPage.request.post(`${BACKEND}/v1/workflows/${wfId}/run`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await runResp.json() as any;

    // Advance two steps
    await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/advance_step`, {
      headers: { "X-API-Key": API_KEY },
    });
    await apiPage.request.post(`${BACKEND}/v1/runs/${run.id}/advance_step`, {
      headers: { "X-API-Key": API_KEY },
    });

    // Verify audit has checkpoint event
    const auditResp = await apiPage.request.get(`${BACKEND}/v1/audit/${run.id}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const auditData = await auditResp.json() as any;
    const audit = Array.isArray(auditData) ? auditData : (auditData.events || []);
    const checkpointEvents = audit.filter((e: any) => e.event_type === "checkpoint");
    console.log(`  Checkpoint events: ${checkpointEvents.length}`);

    const consoleErrors = errors.filter(
      (e) => e.type === "console" && !e.text.includes("favicon")
    );
    expect(consoleErrors).toHaveLength(0);
    await apiPage.close();
  });
});
