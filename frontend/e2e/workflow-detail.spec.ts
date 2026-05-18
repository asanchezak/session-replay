import { test, expect } from "@playwright/test";

const WORKFLOW = {
  id: "wf-1",
  name: "Demo Workflow",
  description: "Test workflow",
  status: "active",
  version: 1,
  target_url: "https://example.com",
  steps: [
    { step_index: 0, action_type: "navigate", selector_chain: [{ type: "css", value: "body" }], value: "https://example.com" },
  ],
  analysis: null,
};

const PARAMETERIZED_WORKFLOW = {
  ...WORKFLOW,
  analysis: {
    workflow_goal: "Collect search results",
    workflow_summary: "Parameterized workflow",
    confidence_overall: 0.95,
    replay_strategy: "parameterized",
    is_user_edited: false,
    phases: [],
    parameters: [
      {
        key: "target_url",
        type: "string",
        default: "https://example.com",
        description: "Search page URL",
        confidence: 0.92,
        required: true,
      },
    ],
    output_spec: {
      type: "object",
      schema: null,
      confidence: 0.5,
    },
  },
};

test.describe("Workflow detail run entry", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const originalPostMessage = window.postMessage.bind(window);
      const openedWindows: Array<{ href: string }> = [];
      const postedMessages: unknown[] = [];
      Object.defineProperty(window, "__testPostedMessages", {
        value: postedMessages,
        configurable: true,
      });
      Object.defineProperty(window, "__testOpenedWindows", {
        value: openedWindows,
        configurable: true,
      });
      window.postMessage = ((message: unknown, targetOrigin: string, transfer?: Transferable[]) => {
        postedMessages.push(message);
        return originalPostMessage(message, targetOrigin, transfer || []);
      }) as typeof window.postMessage;
      window.open = (() => {
        const opened = { href: "/runs/pending" };
        openedWindows.push(opened);
        return {
          closed: false,
          close: () => {},
          location: opened,
        } as unknown as Window;
      }) as typeof window.open;
    });
  });

  test("goal modal can run as recorded and redirects on success", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(WORKFLOW) });
    });

    await page.goto("/workflows/wf-1");
    await page.getByRole("button", { name: /^Run$/i }).click();
    await expect(page.getByRole("heading", { name: "Run With Goal" })).toBeVisible();
    await page.getByRole("button", { name: "Run As Recorded" }).click();

    const postedMessages = await page.evaluate(() => (window as typeof window & { __testPostedMessages: unknown[] }).__testPostedMessages);
    expect(postedMessages).toContainEqual({ type: "DASHBOARD_RUN_WORKFLOW", workflowId: "wf-1" });

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent("message", {
        data: { type: "DASHBOARD_RUN_STARTED", runId: "run-xyz" },
        source: window,
      }));
    });

    await expect.poll(async () => {
      const openedWindows = await page.evaluate(() => (window as typeof window & { __testOpenedWindows: Array<{ href: string }> }).__testOpenedWindows);
      return openedWindows[openedWindows.length - 1]?.href ?? null;
    }).toBe("/runs/run-xyz");
  });

  test("parameterized modal forwards params and an optional goal", async ({ page }) => {
    await page.route("**/v1/workflows/wf-1", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(PARAMETERIZED_WORKFLOW) });
    });

    await page.goto("/workflows/wf-1");
    await page.getByRole("button", { name: /^Run$/i }).click();

    await expect(page.getByRole("heading", { name: "Run with Parameters" })).toBeVisible();
    await page.locator("input#param-target_url").last().fill("https://example.com/search");
    await page.getByLabel("Execution goal (optional)").fill("Extract the first result");
    await page.getByRole("button", { name: "Run Workflow" }).click();

    const postedMessages = await page.evaluate(() => (window as typeof window & { __testPostedMessages: unknown[] }).__testPostedMessages);
    expect(postedMessages).toContainEqual({
      type: "DASHBOARD_RUN_WORKFLOW",
      workflowId: "wf-1",
      params: { target_url: "https://example.com/search" },
      goal: "Extract the first result",
    });
  });
});
