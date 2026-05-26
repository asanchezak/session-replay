import fs from "fs";
import { test, expect } from "./fixtures";
import { PopupPage, ExtensionHelper } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

const PARAGRAPH = "Experienced software engineer with a passion for continuous learning and professional growth. Proficient in ReactJS and AngularJS and IOS for front-end development with a bit of experience in back-end development.";

test("linkedin run emits selected_text for paragraph extract step", async ({ context, extensionId }) => {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) throw new Error("Missing LinkedIn state");
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as { cookies: any[] };
  await context.addCookies(state.cookies);

  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/in/crandrey/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  if (/login|authwall|signup/.test(page.url())) throw new Error(`Auth wall: ${page.url()}`);

  const ext = new ExtensionHelper(context, extensionId);
  const workflowId = await ext.createWorkflowViaAPI(
    `LinkedIn Paragraph Extract ${Date.now()}`,
    [
      {
        event_type: "navigate",
        payload: { value: "https://www.linkedin.com/in/crandrey/", intent: "Navigate to LinkedIn profile" },
      },
      {
        event_type: "extract",
        payload: { value: PARAGRAPH },
      },
    ],
  );

  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();

  const runStart = await popup.page.evaluate(async ({ workflowId }) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => (t.url || "").includes("linkedin.com/in/crandrey/"));
    const response = await chrome.runtime.sendMessage({ type: "RUN_WORKFLOW", workflowId, tabId: target?.id });
    return response as { run?: { id?: string } };
  }, { workflowId });

  const runId = String(runStart?.run?.id || "");
  expect(runId).toBeTruthy();

  let done = false;
  for (let i = 0; i < 60; i++) {
    await popup.page.waitForTimeout(2000);
    const statusResp = await popup.page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const s = await statusResp.json() as any;
    if (["completed", "failed", "canceled", "waiting_for_user"].includes(String(s.status || ""))) {
      done = true;
      break;
    }
  }
  expect(done).toBeTruthy();

  const eventsResp = await popup.page.request.get(`${BACKEND}/v1/runs/${runId}/events?limit=200`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = await eventsResp.json() as any[];
  const extractionEvents = events.filter((e) => e.event_type === "extraction");
  expect(extractionEvents.length).toBeGreaterThan(0);

  const selectedTextValues = extractionEvents
    .flatMap((e) => Array.isArray(e.payload?.data) ? e.payload.data : [])
    .map((r: any) => String(r?.selected_text || "").trim())
    .filter(Boolean);

  expect(selectedTextValues.some((v) => v.includes("Experienced software engineer with a passion"))).toBeTruthy();

  await popup.page.close();
  await page.close();
});
