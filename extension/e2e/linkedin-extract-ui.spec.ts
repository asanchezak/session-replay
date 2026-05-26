import fs from "fs";
import { test, expect } from "./fixtures";
import { PopupPage } from "./page-objects";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const PROFILE_SUMMARY = "Experienced software engineer with a passion for continuous learning and professional growth.";

test.describe.configure({ mode: "serial" });

test("linkedin profile extract via UI records extract step", async ({ context, extensionId }) => {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(`LinkedIn session not found at ${LINKEDIN_STATE_PATH}`);
  }

  const startedAt = Date.now();
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{
      name: string; value: string; domain: string; path: string;
      expires: number; httpOnly: boolean; secure: boolean; sameSite: string;
    }>;
  };
  await context.addCookies(state.cookies);

  const popup = new PopupPage(await context.newPage(), extensionId);
  await popup.open();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();

  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/in/crandrey/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const url = page.url();
  if (url.includes("/login") || url.includes("/authwall") || url.includes("/signup")) {
    await page.screenshot({ path: "test-results/linkedin-extract-authwall.png" });
    throw new Error(`LinkedIn session invalid for profile page; landed on ${url}`);
  }

  const selectionOk = await page.evaluate(() => {
    const candidate = Array.from(document.querySelectorAll("p, span, div")).find((el) => {
      const text = (el.textContent || "").trim();
      return text.includes("Experienced software engineer with a passion for continuous learning and professional growth.");
    }) || null;
    if (!candidate) return false;

    const range = document.createRange();
    range.selectNodeContents(candidate);
    const sel = window.getSelection();
    if (!sel) return false;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return !!sel.toString().trim();
  });
  expect(selectionOk).toBeTruthy();

  const host = page.locator("#sr-extract-host");
  await expect(host).toBeVisible({ timeout: 10000 });
  const box = await host.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.click((box?.x || 0) + ((box?.width || 180) / 2), (box?.y || 0) + 20);
  await page.waitForTimeout(1200);

  await popup.page.bringToFront();
  await popup.page.waitForTimeout(400);
  await popup.clickStop();
  await popup.page.waitForTimeout(3500);

  const wfResp = await popup.page.request.get(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(wfResp.ok()).toBeTruthy();

  const workflows = (await wfResp.json()) as any[];
  const latest = [...workflows]
    .filter((w: any) => new Date(w.created_at).getTime() >= startedAt)
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];

  expect(latest).toBeTruthy();

  const detailResp = await popup.page.request.get(`${BACKEND}/v1/workflows/${latest.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  expect(detailResp.ok()).toBeTruthy();
  const detail = (await detailResp.json()) as any;

  const extractSteps = (detail.steps || []).filter((s: any) => s.action_type === "extract");
  expect(extractSteps.length).toBeGreaterThan(0);

  const hasExtractValue = extractSteps.some(
    (s: any) => typeof s.value === "string" && s.value.includes(PROFILE_SUMMARY),
  );
  expect(hasExtractValue).toBeTruthy();
  const clickSteps = (detail.steps || []).filter((s: any) => s.action_type === "click");
  const summaryClicks = clickSteps.filter((s: any) => typeof s.value === "string" && s.value.includes(PROFILE_SUMMARY));
  expect(summaryClicks).toHaveLength(0);

  await popup.page.close();
  await page.close();
});
