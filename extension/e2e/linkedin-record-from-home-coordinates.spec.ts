/**
 * Records the LinkedIn home-overlay messaging flow using cursor/coordinate
 * clicks instead of direct locator.click() for fragile overlay interactions.
 *
 * Why coordinates:
 * - LinkedIn overlay elements can shift wrappers/attributes between renders.
 * - Cursor clicks preserve actual click point for recorder anchor capture.
 * - This makes click-intent capture more stable on noisy overlay UI.
 *
 * Flow:
 * 1. Load saved LinkedIn cookies
 * 2. Start recording in popup
 * 3. Open linkedin.com/feed
 * 4. Open home Messaging overlay with cursor click
 * 5. Open Franz thread (row click by cursor; search fallback also cursor)
 * 6. Type and send message (send button click by cursor)
 * 7. Verify message appears, stop recording, print workflow id
 *
 * Run with:
 *   cd extension && npx playwright test e2e/linkedin-record-from-home-coordinates.spec.ts --headed
 */
import fs from "fs";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_TOKEN = `sr-home-cursor-${Date.now().toString(36)}`;
const TEST_MESSAGE = `[TEST ${TEST_TOKEN}] automated message from session-replay - please ignore`;
const SEARCH_NAME = "Franz";

test.describe.configure({ mode: "serial" });

async function cursorClick(page: Page, locator: Locator, label: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`Could not compute bounding box for ${label}`);
  }
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.down();
  await page.mouse.up();
  console.log(`  Cursor click: ${label} @ (${x}, ${y})`);
}

async function firstVisible(page: Page, selectors: string[]): Promise<{ locator: Locator; selector: string } | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
      return { locator: loc, selector: sel };
    }
  }
  return null;
}

test("record LinkedIn home chat flow to Franz using cursor coordinates", async ({ context, extensionId }) => {
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
  console.log(`\n[0/6] Loaded ${state.cookies.length} LinkedIn cookies.`);

  console.log("[1/6] Verifying LinkedIn session...");
  const checkPage = await context.newPage();
  await checkPage.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await checkPage.waitForTimeout(2000);
  if (checkPage.url().includes("/login") || checkPage.url().includes("/authwall")) {
    await checkPage.screenshot({ path: "linkedin-debug-auth-home-cursor.png" });
    await checkPage.close();
    throw new Error("LinkedIn session is invalid or expired. Re-run linkedin-setup.spec.ts.");
  }
  await checkPage.close();
  console.log("  Session valid.");

  console.log("[2/6] Starting session recording...");
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.clickRecord();
  await popup.page.waitForTimeout(700);
  if (!(await popup.isRecording())) {
    throw new Error("Extension did not enter recording state.");
  }
  console.log("  Recording started.");

  console.log("[3/6] Opening LinkedIn home feed...");
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  console.log("[4/6] Opening chat list and targeting Franz with cursor...");
  const messagingToggle = await firstVisible(page, [
    ".msg-overlay-list-bubble button:has-text('Messaging')",
    "button:has-text('Messaging')",
    "button[aria-label*='Messaging']",
  ]);
  if (!messagingToggle) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-toggle.png" });
    throw new Error("Could not find Messaging overlay toggle.");
  }
  await cursorClick(page, messagingToggle.locator, `toggle ${messagingToggle.selector}`);
  await page.waitForTimeout(1200);

  const searchInput = await firstVisible(page, [
    ".msg-overlay-list-bubble input[placeholder*='Search']",
    ".msg-overlay-list-bubble input[aria-label*='Search']",
    "input[placeholder='Search messages']",
    "input[aria-label='Search messages']",
  ]);
  if (!searchInput) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-search.png" });
    throw new Error("Could not find search input in home overlay.");
  }

  await cursorClick(page, searchInput.locator, `search ${searchInput.selector}`);
  await page.keyboard.press("ControlOrMeta+A").catch(() => {});
  await page.keyboard.press("Backspace").catch(() => {});
  await page.keyboard.type(SEARCH_NAME, { delay: 90 });
  await page.waitForTimeout(1800);

  const franzAfterSearch = await firstVisible(page, [
    `.msg-conversation-listitem__link:has-text('${SEARCH_NAME}')`,
    `li.msg-conversation-listitem:has-text('${SEARCH_NAME}') a`,
    `.msg-overlay-list-bubble *:has-text('${SEARCH_NAME}')`,
    `[data-control-name='overlay_list_item'] :text('${SEARCH_NAME}')`,
  ]);
  if (!franzAfterSearch) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-franz.png" });
    throw new Error("Could not find Franz in overlay after search.");
  }
  await cursorClick(page, franzAfterSearch.locator, `Franz search row ${franzAfterSearch.selector}`);

  await page.waitForTimeout(1400);

  console.log("[5/6] Sending test message with cursor flow...");
  const messageBox = await firstVisible(page, [
    ".msg-overlay-conversation-bubble div[aria-label='Write a message…']",
    ".msg-overlay-conversation-bubble div[aria-label='Write a message']",
    ".msg-overlay-conversation-bubble div.msg-form__contenteditable",
    "div[role='textbox'][contenteditable='true']",
  ]);
  if (!messageBox) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-messagebox.png" });
    throw new Error("Could not find message box in overlay.");
  }

  await cursorClick(page, messageBox.locator, `message box ${messageBox.selector}`);
  await page.keyboard.type(TEST_MESSAGE, { delay: 60 });
  await page.waitForTimeout(500);

  const sendButton = await firstVisible(page, [
    ".msg-overlay-conversation-bubble button[aria-label='Send']",
    ".msg-overlay-conversation-bubble button.msg-form__send-button",
    "button[aria-label='Send']",
    "button:has-text('Send')",
    "[data-control-name='send']",
  ]);
  if (!sendButton) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-send.png" });
    throw new Error("Could not find Send button.");
  }
  await cursorClick(page, sendButton.locator, `send ${sendButton.selector}`);
  await page.waitForTimeout(2200);

  const sentVisible = await page.locator(`text=${TEST_MESSAGE}`).last().isVisible({ timeout: 10_000 }).catch(() => false);
  if (!sentVisible) {
    await page.screenshot({ path: "linkedin-debug-home-cursor-sent.png" });
    throw new Error("Message was not confirmed in thread after send.");
  }
  console.log(`  Confirmed sent message token: ${TEST_TOKEN}`);

  console.log("[6/6] Stopping recording...");
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(300);
  await popup.clickStop();
  await popup.page.waitForTimeout(2400);

  const resp = await popup.page.request.get(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY },
  });
  if (resp.ok()) {
    const body = await resp.json();
    const workflows: Array<{ id: string; name: string; created_at: string }> = body.workflows ?? body;
    if (workflows.length > 0) {
      const latest = workflows.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )[0];
      console.log("\nWorkflow recorded!");
      console.log(`  ID        : ${latest.id}`);
      console.log(`  Name      : ${latest.name}`);
      console.log(`  Dashboard : http://localhost:5173/workflows/${latest.id}`);
    }
  }

  expect(sentVisible).toBe(true);
  console.log("\nDone. Home chat cursor-based message flow recorded.");
});
