import { test, expect } from "./fixtures";
import { ExtensionHelper } from "./page-objects";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const HOME_URL = "https://qa-website.akurey.com/";
const RUN_LIVE_EXTERNAL_E2E = process.env.RUN_LIVE_EXTERNAL_E2E === "true";
const SAMPLE = {
  country: "Costa Rica",
  email: "qa.session.replay+akurey@example.com",
  phone: "88887777",
  englishLevel: "Fluent",
  yearsExperience: "5",
  salary: "4500",
  linkedIn: "https://www.linkedin.com/in/session-replay-akurey",
  portfolio: "https://github.com/session-replay/akurey-flow",
  fromUs: "LinkedIn",
};

async function waitForContentScript(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => (window as any).__SR_CONTENT_SCRIPT__ === true, null, { timeout: 10000 })
    .catch(() => {});
}

async function navigateToApplyForm(page: import("@playwright/test").Page) {
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await waitForContentScript(page);
  await expect(page.getByRole("link", { name: /^Careers$/i }).first()).toBeVisible({ timeout: 10000 });

  await page.getByRole("link", { name: /^Careers$/i }).first().click();
  await page.waitForURL(/\/careers\/$/);
  await waitForContentScript(page);
  await expect(page.getByText("OPEN POSITIONS")).toBeVisible({ timeout: 10000 });

  await page.locator('a[href*="/careers/requirements/"]').first().click();
  await page.waitForURL(/\/careers\/requirements\/\?pId=/);
  await waitForContentScript(page);
  await expect(page.getByText(/WHAT WE'RE LOOKING FOR/i)).toBeVisible({ timeout: 10000 });

  await page.getByRole("link", { name: /apply now/i }).first().click();
  await page.waitForURL(/\/careers\/apply\/\?pId=/);
  await waitForContentScript(page);
  await expect(page.getByText("PERSONAL INFO")).toBeVisible({ timeout: 10000 });
}

async function fillApplyForm(page: import("@playwright/test").Page) {
  await page.locator('select[name="rcrs-country"]').selectOption({ label: SAMPLE.country });
  await page.locator("#email").fill(SAMPLE.email);
  await page.locator("#phone").fill(SAMPLE.phone);
  await page.locator('input[name="engLevel"]').click();
  await page.getByText(SAMPLE.englishLevel, { exact: true }).click();
  await page.locator("#yearsExperience").fill(SAMPLE.yearsExperience);
  await page.locator("#rangeSalary").fill(SAMPLE.salary);
  await page.locator("#linkedIn").fill(SAMPLE.linkedIn);
  await page.locator("#portfolio").fill(SAMPLE.portfolio);
  await page.locator('input[name="fromUs"]').click();
  await page.getByText(SAMPLE.fromUs, { exact: true }).click();
  await page.locator("#check").check();

  await page.locator("#fileSelector").setInputFiles({
    name: "session-replay-resume.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"),
  });

  // Blur the last text field so recorder paths that rely on change events persist the value.
  await page.locator("#check").focus();
  await page.waitForTimeout(300);
}

async function fetchLatestWorkflow(page: import("@playwright/test").Page, startedAt: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const resp = await page.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    const workflows = (await resp.json()) as any[];
    const match = workflows
      .filter((w) =>
        new Date(w.created_at).getTime() >= startedAt &&
        String(w.target_url || "").includes("qa-website.akurey.com"))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    if (match) return match;
    await page.waitForTimeout(1000);
  }
  throw new Error("Did not find recorded Akurey workflow");
}

test.describe.configure({ mode: "serial" });
test.skip(!RUN_LIVE_EXTERNAL_E2E, "Live external Akurey careers E2E disabled by default. Set RUN_LIVE_EXTERNAL_E2E=true to enable.");

test("Akurey apply form can be filled without submission", async ({ context, errors }) => {
  const page = await context.newPage();

  await navigateToApplyForm(page);
  await fillApplyForm(page);

  await expect(page.locator("#email")).toHaveValue(SAMPLE.email);
  await expect(page.locator("#phone")).toHaveValue(SAMPLE.phone);
  await expect(page.locator('input[name="engLevel"]')).toHaveValue(SAMPLE.englishLevel);
  await expect(page.locator("#yearsExperience")).toHaveValue(SAMPLE.yearsExperience);
  await expect(page.locator("#rangeSalary")).toHaveValue(SAMPLE.salary);
  await expect(page.locator("#linkedIn")).toHaveValue(SAMPLE.linkedIn);
  await expect(page.locator("#portfolio")).toHaveValue(SAMPLE.portfolio);
  await expect(page.locator('input[name="fromUs"]')).toHaveValue(SAMPLE.fromUs);
  await expect(page.locator("#check")).toBeChecked();
  const fileCount = await page.locator("#fileSelector").evaluate((el) => (el as HTMLInputElement).files?.length || 0);
  expect(fileCount).toBe(1);

  const selectedCountry = await page.locator('select[name="rcrs-country"]').evaluate((el) =>
    (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() || "");
  expect(selectedCountry).toBe(SAMPLE.country);

  expect(errors.filter((e) => e.type === "console" && e.url?.includes("qa-website.akurey.com"))).toHaveLength(0);
  await page.close();
});

test("extension records the Akurey careers apply flow", async ({ context, extensionId, errors }) => {
  const ext = new ExtensionHelper(context, extensionId);
  const page = await context.newPage();

  await navigateToApplyForm(page);

  const recordingStartedAt = Date.now();
  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();

  await page.bringToFront();
  await page.waitForTimeout(500);

  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await waitForContentScript(page);
  await page.getByRole("link", { name: /^Careers$/i }).first().click();
  await page.waitForURL(/\/careers\/$/);
  await waitForContentScript(page);
  await page.locator('a[href*="/careers/requirements/"]').first().click();
  await page.waitForURL(/\/careers\/requirements\/\?pId=/);
  await waitForContentScript(page);
  await page.getByRole("link", { name: /apply now/i }).first().click();
  await page.waitForURL(/\/careers\/apply\/\?pId=/);
  await waitForContentScript(page);

  await fillApplyForm(page);

  await popup.page.bringToFront();
  await popup.page.waitForTimeout(500);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);
  expect(await popup.isIdle()).toBeTruthy();

  const workflow = await fetchLatestWorkflow(page, recordingStartedAt);
  const detailResp = await page.request.get(`${BACKEND}/v1/workflows/${workflow.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const detail = (await detailResp.json()) as any;
  const steps = detail.steps as Array<any>;

  console.log(`  Recorded workflow: ${workflow.id} (${steps.length} steps)`);
  for (const step of steps) {
    console.log(`    ${step.step_index}. ${step.action_type} value=${JSON.stringify(step.value)} intent=${JSON.stringify(step.intent)}`);
  }

  const clickSteps = steps.filter((s) => s.action_type === "click");
  const typeSteps = steps.filter((s) => s.action_type === "type");
  const selectSteps = steps.filter((s) => s.action_type === "select");
  // Accept both "click" and "navigate" steps — the recorder captures navigation
  // as click events when the content script catches them, or as navigate events
  // synthesized by the service worker's tabs.onUpdated fallback.
  const navigationSteps = steps.filter((s) =>
    (s.action_type === "click" || s.action_type === "navigate") &&
    /careers|requirements|apply/i.test(String(s.intent || "")));

  expect(clickSteps.length).toBeGreaterThanOrEqual(4);
  expect(typeSteps.length).toBeGreaterThanOrEqual(6);
  expect(selectSteps.length).toBeGreaterThanOrEqual(1);
  expect(navigationSteps.length).toBeGreaterThanOrEqual(3);
  expect(typeSteps.some((s) => s.value === SAMPLE.email)).toBe(true);
  expect(typeSteps.some((s) => s.value === SAMPLE.fromUs)).toBe(true);

  const allValues = steps.map((s) => String(s.value || ""));
  console.log("  Recorded values:", allValues);
  expect(allValues.some((value) => value.includes("fakepath"))).toBe(false);

  expect(errors.filter((e) => e.type === "console" && e.url?.includes("chrome-extension://"))).toHaveLength(0);

  await popup.page.close();
  await page.close();
});
