/**
 * Records a session-replay workflow on LinkedIn:
 * 1. Loads LinkedIn session cookies into a fresh extension context
 * 2. Starts recording via the extension popup
 * 3. Opens LinkedIn messaging, composes a message to Franz
 * 4. Sends the test message
 * 5. Stops recording and prints the workflow ID + dashboard URL
 *
 * Prerequisites: run linkedin-setup.spec.ts once first.
 *
 * Run with:
 *   cd extension && npx playwright test e2e/linkedin-record.spec.ts --headed
 */
import fs from "fs";
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_TOKEN = `sr-${Date.now().toString(36)}`;
const TEST_MESSAGE = `[TEST ${TEST_TOKEN}] automated message from session-replay - please ignore`;
const SEARCH_NAME = "Franz";

test.describe.configure({ mode: "serial" });

test("record LinkedIn message flow to Franz", async ({ context, extensionId }) => {
  // ── 0. Inject saved LinkedIn cookies ──────────────────────────────────────
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(
      `LinkedIn session not found at ${LINKEDIN_STATE_PATH}.\n` +
      "Run linkedin-setup.spec.ts first: npx playwright test e2e/linkedin-setup.spec.ts --headed"
    );
  }
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{
      name: string; value: string; domain: string; path: string;
      expires: number; httpOnly: boolean; secure: boolean; sameSite: string;
    }>;
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  await context.addCookies(state.cookies);
  console.log(`\n[0/6] Loaded ${state.cookies.length} LinkedIn cookies.`);

  // ── 1. Verify session is valid ─────────────────────────────────────────────
  console.log("[1/6] Verifying LinkedIn session...");
  const checkPage = await context.newPage();
  await checkPage.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await checkPage.waitForTimeout(2000);

  const currentUrl = checkPage.url();
  if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
    await checkPage.screenshot({ path: "linkedin-debug-auth.png" });
    await checkPage.close();
    throw new Error(
      "LinkedIn session is invalid or expired. Re-run linkedin-setup.spec.ts to refresh it."
    );
  }
  console.log("  Session valid.");
  await checkPage.close();

  // ── 2. Start recording ─────────────────────────────────────────────────────
  console.log("[2/6] Starting session recording...");
  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.clickRecord();
  await popup.page.waitForTimeout(500);

  if (!(await popup.isRecording())) {
    throw new Error("Extension did not enter recording state.");
  }
  console.log("  Recording started.");

  // ── 3. Open LinkedIn messaging ─────────────────────────────────────────────
  console.log("[3/6] Opening LinkedIn messaging...");
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // ── 4. Search for Franz in the messaging search bar ──────────────────────
  console.log(`[4/6] Searching for "${SEARCH_NAME}" in messaging search...`);

  // Close any open dropdown by pressing Escape first
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const searchBar = page.locator("input[placeholder='Search messages'], input[aria-label='Search messages']").first();
  if (!(await searchBar.isVisible({ timeout: 3000 }).catch(() => false))) {
    await page.screenshot({ path: "linkedin-debug-search.png" });
    throw new Error("Could not find 'Search messages' bar. See linkedin-debug-search.png.");
  }

  await searchBar.click();
  await searchBar.clear();
  await searchBar.type(SEARCH_NAME, { delay: 100 });
  await page.waitForTimeout(2000);

  // ── 5. Ensure Franz's conversation is open ────────────────────────────────
  console.log(`[5/6] Opening Franz's conversation...`);

  // LinkedIn may auto-open the conversation when searching. Check if the
  // message compose box is already visible before trying to click anything.
  const messageBoxCheck = page.locator(
    "div[aria-label='Write a message…'], div[aria-label='Write a message'], " +
    "div.msg-form__contenteditable, [data-placeholder='Write a message…']"
  ).first();

  const alreadyOpen = await messageBoxCheck.isVisible({ timeout: 2000 }).catch(() => false);

  if (!alreadyOpen) {
    // Conversation not yet open — try to click the first result in the sidebar
    const conversationSelectors = [
      ".msg-conversation-listitem__link",
      "li.msg-conversation-listitem a",
      "[data-control-name='view_conversation']",
      ".msg-conversations-container li:first-child a",
      // Fallback: click the conversation header visible on the right pane
      ".msg-thread__top-bar",
    ];

    let conversationClicked = false;
    for (const sel of conversationSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        await el.click();
        conversationClicked = true;
        console.log(`  Clicked conversation: ${sel}`);
        break;
      }
    }

    if (!conversationClicked) {
      await page.screenshot({ path: "linkedin-debug-conversation.png" });
      throw new Error("Could not open Franz's conversation. See linkedin-debug-conversation.png.");
    }
    await page.waitForTimeout(1500);
  } else {
    console.log("  Conversation already open (auto-selected by LinkedIn).");
  }

  // ── 6. Type and send message ──────────────────────────────────────────────
  console.log("[5/6] Sending test message...");
  const messageBoxSelectors = [
    "div[aria-label='Write a message…']",
    "div[aria-label='Write a message']",
    "div.msg-form__contenteditable",
    "div[role='textbox'][contenteditable='true']",
    "[data-placeholder='Write a message…']",
  ];

  let messageBox = null;
  for (const sel of messageBoxSelectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      messageBox = el;
      console.log(`  Message box: ${sel}`);
      break;
    }
  }

  if (!messageBox) {
    await page.screenshot({ path: "linkedin-debug-messagebox.png" });
    throw new Error("Could not find message compose box. See linkedin-debug-messagebox.png.");
  }

  await messageBox.click();
  await messageBox.type(TEST_MESSAGE, { delay: 60 });
  await page.waitForTimeout(500);

  let sent = false;
  for (const sel of [
    "button[aria-label='Send']",
    "button.msg-form__send-button",
    "button:has-text('Send')",
    "[data-control-name='send']",
  ]) {
    const btn = page.locator(sel).first();
    if (
      await btn.isVisible({ timeout: 1000 }).catch(() => false) &&
      await btn.isEnabled({ timeout: 1000 }).catch(() => false)
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

  await page.waitForTimeout(2000);

  // Verify the just-sent message is visible in the thread, not just that
  // the Send click succeeded.
  const sentMessage = page.locator(`text=${TEST_MESSAGE}`).last();
  const sentVisible = await sentMessage.isVisible({ timeout: 8000 }).catch(() => false);
  if (!sentVisible) {
    await page.screenshot({ path: "linkedin-debug-sent-message.png" });
    throw new Error("Message was not confirmed in thread after send. See linkedin-debug-sent-message.png.");
  }
  console.log(`  Confirmed sent message token: ${TEST_TOKEN}`);

  // ── 7. Stop recording ─────────────────────────────────────────────────────
  console.log("[6/6] Stopping recording...");
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(300);
  await popup.clickStop();
  await popup.page.waitForTimeout(2000);

  // Fetch the most recently created workflow
  const resp = await popup.page.request.get(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY },
  });
  if (resp.ok()) {
    const body = await resp.json();
    const workflows: Array<{ id: string; name: string; created_at: string }> =
      body.workflows ?? body;
    if (workflows.length > 0) {
      const latest = workflows.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )[0];
      console.log(`\nWorkflow recorded!`);
      console.log(`  ID        : ${latest.id}`);
      console.log(`  Name      : ${latest.name}`);
      console.log(`  Dashboard : http://localhost:5173/workflows/${latest.id}`);
    }
  }

  expect(sent).toBe(true);
  console.log("\nDone. LinkedIn message sent and session captured.");
});
