/**
 * Real-Chromium tests for every popup state view.
 *
 * Drives the orchestrator's broadcastState/notify* methods from the
 * service worker and verifies the popup DOM renders correctly for:
 *   idle, recording, running, running_parameterized, recovering,
 *   waiting_for_user, failed, error
 *
 * This catches runtime render bugs: wrong text, missing buttons,
 * broken progress bars, invisible views, etc.
 */
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

test.describe("Popup state views", () => {

  test("idle state: shows Record and Run buttons", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    await expect(popup.page.getByText("Record Workflow")).toBeVisible();
    await expect(popup.page.getByText("Run Workflow")).toBeVisible();
    await expect(popup.page.getByText("Session Replay")).toBeVisible();
    await expect(popup.page.getByText("Connected")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("recording state: shows step count and stop button", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // Start recording via popup button
    await popup.clickRecord();
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Recording...").first()).toBeVisible();
    await expect(popup.page.getByText("Stop Recording")).toBeVisible();
    await expect(popup.page.getByText("0 steps")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("running state: shows progress bar, step count, pause button", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // Broadcast running state from the service worker
    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      const { orchestrator } = (globalThis as any).__imports || {};
      // Access orchestrator via require or globals — it's a module singleton
      // We broadcast via sendMessage to simulate what the orchestrator does
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: "Test Workflow",
          current_step: 3,
          total_steps: 7,
          run_id: "run-123",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Test Workflow")).toBeVisible();
    await expect(popup.page.getByText("Step 3/7")).toBeVisible();
    await expect(popup.page.getByText("43% complete")).toBeVisible();
    await expect(popup.page.getByText("Pause")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("recovering state: shows auto-healing banner with step info", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "recovering",
          workflow_name: "Heal Workflow",
          current_step: 4,
          total_steps: 7,
          run_id: "run-456",
          error: "Element not found — attempting recovery",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Auto-Healing...")).toBeVisible();
    await expect(popup.page.getByText("Heal Workflow")).toBeVisible();
    await expect(popup.page.getByText("Step 4/7")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("waiting_for_user state: shows reason and Resume button", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "waiting_for_user",
          reason: "CAPTCHA detected on LinkedIn — action required",
          run_id: "run-789",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Action Required", { exact: true })).toBeVisible();
    await expect(popup.page.getByText("CAPTCHA detected on LinkedIn — action required")).toBeVisible();
    await expect(popup.page.getByText("I've Handled It → Resume")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("error state: shows error message", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "error",
          message: "Failed to connect to backend",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Error")).toBeVisible();
    await expect(popup.page.getByText("Failed to connect to backend")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("'failed' state renders error summary", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "failed",
          workflow_name: "Failed Run",
          current_step: 3,
          total_steps: 5,
          run_id: "run-fail-1",
          error: "Selector not found",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Error")).toBeVisible();
    await expect(popup.page.getByText(/Failed Run failed at step 3\/5/)).toBeVisible();
    await expect(popup.page.getByText("Selector not found")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("running_parameterized state reuses running view", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running_parameterized",
          workflow_name: "Param Workflow",
          current_step: 1,
          total_steps: 4,
          run_id: "run-param-1",
          params: { query: "qa engineer" },
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Param Workflow")).toBeVisible();
    await expect(popup.page.getByText("Step 1/4")).toBeVisible();
    await expect(popup.page.getByText("25% complete")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("state transitions: idle → recording → idle", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    // idle → recording
    await popup.clickRecord();
    await popup.page.waitForTimeout(500);
    await expect(popup.page.getByText("Recording...").first()).toBeVisible();

    // recording → idle
    await popup.clickStop();
    await popup.page.waitForTimeout(2000);
    await expect(popup.page.getByText("Record Workflow")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("running → waiting_for_user transition updates the view", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    // Start as running
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: "Search Flow",
          current_step: 2,
          total_steps: 5,
          run_id: "run-transition",
        },
      });
    });
    await popup.page.waitForTimeout(300);
    await expect(popup.page.getByText("Search Flow")).toBeVisible();

    // Transition to waiting_for_user
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "waiting_for_user",
          reason: "Login form appeared",
          run_id: "run-transition",
        },
      });
    });
    await popup.page.waitForTimeout(300);

    await expect(popup.page.getByText("Action Required")).toBeVisible();
    await expect(popup.page.getByText("Login form appeared")).toBeVisible();
    // Previous running state should be gone
    await expect(popup.page.getByText("Search Flow")).not.toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

});
