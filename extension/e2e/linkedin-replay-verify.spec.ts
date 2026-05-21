import fs from "fs";
import { test, expect } from "./fixtures";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const WORKFLOW_ID = process.env.LINKEDIN_WORKFLOW_ID || "ccf9ebc5-308f-436b-a9ee-6e50615fda04";
const RUN_LINKEDIN_LIVE_E2E = process.env.RUN_LINKEDIN_LIVE_E2E === "true";

test.describe.configure({ mode: "serial" });
test.skip(!RUN_LINKEDIN_LIVE_E2E, "LinkedIn live replay E2E is disabled by default. Set RUN_LINKEDIN_LIVE_E2E=true.");

async function openFranzConversation(page: import("@playwright/test").Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);

  const search = page.locator("input[placeholder='Search messages'], input[aria-label='Search messages']").first();
  await expect(search).toBeVisible({ timeout: 10_000 });
  await search.click();
  await search.fill("Franz");
  await page.waitForTimeout(2_000);

  const messageBoxCheck = page.locator(
    "div[aria-label='Write a message…'], div[aria-label='Write a message'], " +
    "div.msg-form__contenteditable, [data-placeholder='Write a message…']",
  ).first();

  const alreadyOpen = await messageBoxCheck.isVisible({ timeout: 2_000 }).catch(() => false);
  if (alreadyOpen) {
    return;
  }

  for (const sel of [
    ".msg-conversation-listitem__link",
    "li.msg-conversation-listitem a",
    "[data-control-name='view_conversation']",
    ".msg-conversations-container li:first-child a",
    ".msg-thread__top-bar",
  ]) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await candidate.click();
      await page.waitForTimeout(1_500);
      return;
    }
  }

  throw new Error("Could not open Franz conversation from search results.");
}

test("replay LinkedIn flow completes and confirms message delivery", async ({ context, extensionId }) => {
  test.setTimeout(6 * 60_000);

  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(
      `LinkedIn session not found at ${LINKEDIN_STATE_PATH}.\n` +
      "Run linkedin-setup.spec.ts first: npx playwright test e2e/linkedin-setup.spec.ts --headed",
    );
  }

  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{
      name: string;
      value: string;
      domain: string;
      path: string;
      expires: number;
      httpOnly: boolean;
      secure: boolean;
      sameSite: string;
    }>;
  };
  await context.addCookies(state.cookies);

  const page = await context.newPage();
  // Start at /feed/ matching the workflow's step-0 navigate target — the
  // workflow's step 1 toggles the Messaging dock open, which only works if
  // the dock starts CLOSED. If we instead start at /messaging/ (or anywhere
  // with the overlay already open) the toggle closes the overlay and step 2
  // can't find Franz's conversation card.
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);

  if (page.url().includes("/login") || page.url().includes("/authwall")) {
    throw new Error("LinkedIn session is invalid or expired. Re-run linkedin-setup.spec.ts.");
  }

  // Force the Messaging dock CLOSED before triggering. LinkedIn restores the
  // dock's last state via sessionStorage; if it was left open by a previous
  // run, the workflow's step-1 toggle would close it instead of open it.
  await page.evaluate(() => {
    try {
      // Click the dock minimise button if expanded (host attribute differs)
      const toggle = document.querySelector<HTMLElement>(
        ".msg-overlay-list-bubble--is-active button[aria-label*='Minimize'], "
        + ".msg-overlay-list-bubble--is-active button[aria-label*='Close']",
      );
      if (toggle) toggle.click();
    } catch { /* no-op */ }
  });
  await page.waitForTimeout(800);

  const token = `sr-replay-${Date.now().toString(36)}`;
  const message = `[TEST ${token}] automated message from session-replay - please ignore`;
  const beforeCount = await page.locator(`text=${message}`).count();

  const activateResp = await page.request.put(`${BACKEND}/v1/workflows/${WORKFLOW_ID}/status`, {
    headers: {
      "X-API-Key": API_KEY,
      "Content-Type": "application/json",
    },
    data: { status: "active" },
  });
  if (!activateResp.ok()) {
    const body = await activateResp.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    const alreadyActive = body?.error?.code === "INVALID_TRANSITION"
      && (body.error.message || "").toLowerCase().includes("active");
    if (!alreadyActive) {
      throw new Error(`Failed to activate workflow ${WORKFLOW_ID}: ${JSON.stringify(body)}`);
    }
  }

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/dist/popup.html`, { waitUntil: "domcontentloaded" });
  await popup.waitForTimeout(800);

  const runStart = await popup.evaluate(async ({ workflowId, payloadMessage }) => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targetTab = tabs.find((tab) => tab.url?.includes("linkedin.com/messaging"))
      || tabs.find((tab) => tab.url?.includes("linkedin.com"))
      || tabs[0];

    const response = await chrome.runtime.sendMessage({
      type: "RUN_WORKFLOW",
      workflowId,
      tabId: targetTab?.id,
      params: { recipient: payloadMessage },
    });

    return { tabId: targetTab?.id ?? null, response };
  }, { workflowId: WORKFLOW_ID, payloadMessage: message });

  const runId = (runStart as { response?: { run?: { id?: string } } })?.response?.run?.id;
  expect(runId, `RUN_WORKFLOW failed: ${JSON.stringify(runStart)}`).toBeTruthy();

  const terminal = new Set(["completed", "failed", "canceled", "waiting_for_user"]);
  let finalRun: {
    status?: string;
    current_step_index?: number;
    total_steps?: number;
    error_message?: string | null;
  } | null = null;

  for (let attempt = 0; attempt < 150; attempt++) {
    const runResp = await page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    finalRun = await runResp.json() as typeof finalRun;
    if (finalRun?.status && terminal.has(finalRun.status)) {
      break;
    }
    await page.waitForTimeout(2_000);
  }

  expect(finalRun).toBeTruthy();
  expect(finalRun?.status).toBe("completed");
  expect(finalRun?.current_step_index).toBe(finalRun?.total_steps);

  await page.bringToFront();
  const sentVisible = await page.locator(`text=${message}`).last().isVisible({ timeout: 20_000 }).catch(() => false);
  const afterCount = await page.locator(`text=${message}`).count();

  expect(sentVisible).toBe(true);
  expect(afterCount).toBeGreaterThan(beforeCount);
});
