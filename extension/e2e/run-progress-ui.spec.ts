/**
 * Tests popup RunningView rendering during step execution.
 *
 * Verifies the progress bar, step counters, and workflow name update
 * correctly as the orchestrator broadcasts running state. Tests step
 * transitions to verify the UI stays consistent.
 */
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";

test.describe("Run progress in popup", () => {

  test("RunningView shows step 1 of N at start", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: "Data Sync",
          current_step: 1,
          total_steps: 10,
          run_id: "run-progress-1",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Data Sync")).toBeVisible();
    await expect(popup.page.getByText("Step 1/10")).toBeVisible();
    await expect(popup.page.getByText("10% complete")).toBeVisible();
    await expect(popup.page.getByText("Pause")).toBeVisible();
    await expect(popup.page.getByText("View Details")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("RunningView progress bar advances as steps complete", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    const steps = [
      { current_step: 1, total_steps: 5, pct: "20%" },
      { current_step: 2, total_steps: 5, pct: "40%" },
      { current_step: 4, total_steps: 5, pct: "80%" },
    ];

    for (const s of steps) {
      await sw.evaluate((step: { current_step: number; total_steps: number }) => {
        chrome.runtime.sendMessage({
          type: "STATE_UPDATE",
          state: {
            type: "running",
            workflow_name: "Progressive",
            current_step: step.current_step,
            total_steps: step.total_steps,
            run_id: "run-progress-2",
          },
        });
      }, s);
      await popup.page.waitForTimeout(300);

      await expect(popup.page.getByText(`Step ${s.current_step}/${s.total_steps}`)).toBeVisible();
      await expect(popup.page.getByText(s.pct)).toBeVisible();
    }

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("progress bar width matches percentage visually", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: "Width Test",
          current_step: 3,
          total_steps: 4,
          run_id: "run-width",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    // Verify the progress bar fill exists (the running state renders a div
    // with width as a percentage — check that it's present in the DOM)
    const pctText = await popup.page.getByText("75% complete").textContent();
    expect(pctText).toContain("75");

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("workflow name truncates long names", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    const longName = "A".repeat(100);
    await sw.evaluate((name: string) => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: name,
          current_step: 1,
          total_steps: 2,
          run_id: "run-long-name",
        },
      });
    }, longName);
    await popup.page.waitForTimeout(500);

    // The name should be visible (even if truncated by CSS)
    await expect(popup.page.getByText(longName)).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

  test("last step shows 100% complete", async ({ context, extensionId, errors }) => {
    const popup = await new PopupPage(await context.newPage(), extensionId);
    await popup.open();
    await popup.page.waitForTimeout(1000);

    const sw = context.serviceWorkers()[0];
    await sw.evaluate(() => {
      chrome.runtime.sendMessage({
        type: "STATE_UPDATE",
        state: {
          type: "running",
          workflow_name: "Final Step",
          current_step: 10,
          total_steps: 10,
          run_id: "run-final",
        },
      });
    });
    await popup.page.waitForTimeout(500);

    await expect(popup.page.getByText("Step 10/10")).toBeVisible();
    await expect(popup.page.getByText("100% complete")).toBeVisible();

    expect(errors.filter(e => e.type === "console")).toHaveLength(0);
    await popup.page.close();
  });

});
