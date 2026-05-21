/**
 * Records a LinkedIn workflow that starts from the home feed and uses the
 * home messaging overlay:
 * 1. Loads saved LinkedIn cookies into a fresh extension context
 * 2. Starts recording via extension popup
 * 3. Opens linkedin.com/feed
 * 4. Opens home chat list overlay, searches Franz, opens the thread
 * 5. Sends a test message and verifies it is visible in the thread
 * 6. Stops recording and prints workflow ID
 *
 * Run with:
 *   cd extension && npx playwright test e2e/linkedin-record-from-home.spec.ts --headed
 */
import fs from "fs";
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_TOKEN = `sr-home-${Date.now().toString(36)}`;
const TEST_MESSAGE = `[TEST ${TEST_TOKEN}] automated message from session-replay - please ignore`;
const SEARCH_NAME = "Franz";

test.describe.configure({ mode: "serial" });

test("record LinkedIn home chat flow to Franz", async ({ context, extensionId }) => {
  // ── 0. Inject saved LinkedIn cookies ──────────────────────────────────────
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

  // ── 1. Verify session is valid ─────────────────────────────────────────────
  console.log("[1/6] Verifying LinkedIn session...");
  const checkPage = await context.newPage();
  await checkPage.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await checkPage.waitForTimeout(2000);
  if (checkPage.url().includes("/login") || checkPage.url().includes("/authwall")) {
    await checkPage.screenshot({ path: "linkedin-debug-auth-home.png" });
    await checkPage.close();
    throw new Error("LinkedIn session is invalid or expired. Re-run linkedin-setup.spec.ts.");
  }
  console.log("  Session valid.");
  await checkPage.close();

  // ── 2. Start recording ─────────────────────────────────────────────────────
  console.log("[2/6] Starting session recording...");
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.clickRecord();
  await popup.page.waitForTimeout(600);
  if (!(await popup.isRecording())) {
    throw new Error("Extension did not enter recording state.");
  }
  console.log("  Recording started.");

  // ── 3. Open LinkedIn home feed ─────────────────────────────────────────────
  console.log("[3/6] Opening LinkedIn home feed...");
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // ── 4. Open home chat list and select Franz ────────────────────────────────
  console.log(`[4/6] Opening home chat list and searching "${SEARCH_NAME}"...`);

  let openedOverlay = false;
  for (const sel of [
    // Prefer the "Messaging" title/toggle button on the home overlay.
    ".msg-overlay-list-bubble button:has-text('Messaging')",
    "button:has-text('Messaging')",
    // Fallback for shells that only expose an aria-label.
    "button[aria-label*='Messaging']",
  ]) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(1200);
      openedOverlay = true;
      console.log(`  Opened chat list via: ${sel}`);
      break;
    }
  }

  if (!openedOverlay) {
    await page.screenshot({ path: "linkedin-debug-home-chat-toggle.png" });
    throw new Error("Could not open home chat list overlay. See linkedin-debug-home-chat-toggle.png.");
  }

  let franzOpened = false;
  for (const sel of [
    `.msg-conversation-listitem__link:has-text('${SEARCH_NAME}')`,
    `li.msg-conversation-listitem:has-text('${SEARCH_NAME}') a`,
    `.msg-overlay-list-bubble *:has-text('${SEARCH_NAME}')`,
    `[data-control-name='overlay_list_item'] :text('${SEARCH_NAME}')`,
  ]) {
    const candidate = page.locator(sel).first();
    if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
      await candidate.click();
      franzOpened = true;
      console.log(`  Opened Franz thread via: ${sel}`);
      break;
    }
  }

  if (!franzOpened) {
    const homeSearch = page.locator(
      ".msg-overlay-list-bubble input[placeholder*='Search'], " +
      "input[placeholder='Search messages'], input[aria-label='Search messages']",
    ).first();

    if (!(await homeSearch.isVisible({ timeout: 4000 }).catch(() => false))) {
      // If we accidentally opened the "New message" dialog, ESC closes it.
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(600);
    }

    if (await homeSearch.isVisible({ timeout: 2500 }).catch(() => false)) {
      await homeSearch.click();
      await homeSearch.type(SEARCH_NAME, { delay: 80 });
      // Force blur so LinkedIn emits change-style events for recorder capture.
      await homeSearch.press("Tab").catch(() => {});
      await page.waitForTimeout(1500);

      for (const sel of [
        `.msg-conversation-listitem__link:has-text('${SEARCH_NAME}')`,
        `li.msg-conversation-listitem:has-text('${SEARCH_NAME}') a`,
        `.msg-overlay-list-bubble *:has-text('${SEARCH_NAME}')`,
        `[data-control-name='overlay_list_item'] :text('${SEARCH_NAME}')`,
      ]) {
        const candidate = page.locator(sel).first();
        if (await candidate.isVisible({ timeout: 1500 }).catch(() => false)) {
          await candidate.click();
          franzOpened = true;
          console.log(`  Opened Franz thread via search using: ${sel}`);
          break;
        }
      }
    }
  }

  if (!franzOpened) {
    await page.screenshot({ path: "linkedin-debug-home-chat-franz.png" });
    throw new Error("Could not open Franz from home chat list. See linkedin-debug-home-chat-franz.png.");
  }
  await page.waitForTimeout(1400);

  // ── 5. Send and verify message ─────────────────────────────────────────────
  console.log("[5/6] Sending test message from home chat...");
  let messageBox = null;
  for (const sel of [
    ".msg-overlay-conversation-bubble div[aria-label='Write a message…']",
    ".msg-overlay-conversation-bubble div[aria-label='Write a message']",
    ".msg-overlay-conversation-bubble div.msg-form__contenteditable",
    "div[role='textbox'][contenteditable='true']",
  ]) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      messageBox = el;
      console.log(`  Message box: ${sel}`);
      break;
    }
  }

  if (!messageBox) {
    await page.screenshot({ path: "linkedin-debug-home-chat-messagebox.png" });
    throw new Error("Could not find message compose box. See linkedin-debug-home-chat-messagebox.png.");
  }

  await messageBox.click();
  await messageBox.type(TEST_MESSAGE, { delay: 60 });
  // Blur once to favor change/input capture before clicking Send.
  await messageBox.press("Tab").catch(() => {});
  await page.waitForTimeout(500);

  let sent = false;
  for (const sel of [
    ".msg-overlay-conversation-bubble button[aria-label='Send']",
    ".msg-overlay-conversation-bubble button.msg-form__send-button",
    "button[aria-label='Send']",
    "button:has-text('Send')",
    "[data-control-name='send']",
  ]) {
    const btn = page.locator(sel).first();
    if (
      await btn.isVisible({ timeout: 1000 }).catch(() => false)
      && await btn.isEnabled({ timeout: 1000 }).catch(() => false)
    ) {
      await btn.click();
      sent = true;
      console.log(`  Sent via: ${sel}`);
      break;
    }
  }

  if (!sent) {
    await messageBox.press("Enter");
    sent = true;
    console.log("  Sent via Enter.");
  }

  await page.waitForTimeout(2200);

  const sentMessage = page.locator(`text=${TEST_MESSAGE}`).last();
  const sentVisible = await sentMessage.isVisible({ timeout: 10000 }).catch(() => false);
  if (!sentVisible) {
    await page.screenshot({ path: "linkedin-debug-home-chat-sent.png" });
    throw new Error("Message was not confirmed in thread after send. See linkedin-debug-home-chat-sent.png.");
  }
  console.log(`  Confirmed sent message token: ${TEST_TOKEN}`);

  // ── 6. Stop recording ─────────────────────────────────────────────────────
  console.log("[6/6] Stopping recording...");
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(300);
  await popup.clickStop();
  await popup.page.waitForTimeout(2200);

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

  expect(sent).toBe(true);
  console.log("\nDone. Home chat message sent and session captured.");
});
