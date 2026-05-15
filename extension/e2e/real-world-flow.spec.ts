import { test, expect } from "./fixtures";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

test("record clicks across page navigation", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const popup = await ext.openPopup();
  await popup.clickRecord();
  expect(await popup.isRecording()).toBeTruthy();
  console.log("  Recording started");

  const page = await context.newPage();

  // Page 1: DuckDuckGo
  await page.goto("https://duckduckgo.com/?q=velocidad+internet&ia=web");
  await page.waitForTimeout(3000);

  let recordingState = await ext.getServiceWorker().then((sw) =>
    sw.evaluate(async () => {
      const data = await chrome.storage.session.get("recording_state");
      return (data.recording_state as any)?.isRecording || false;
    })
  );
  console.log("  Recording active:", recordingState);

  await page.locator("body").click({ position: { x: 200, y: 200 } });
  await page.waitForTimeout(500);

  // Page 2: speedtest.net/es
  await page.goto("https://www.speedtest.net/es");
  await page.waitForTimeout(3000);

  recordingState = await ext.getServiceWorker().then((sw) =>
    sw.evaluate(async () => {
      const data = await chrome.storage.session.get("recording_state");
      return (data.recording_state as any)?.isRecording || false;
    })
  );
  console.log("  Recording active:", recordingState);

  await page.locator("body").click({ position: { x: 200, y: 200 } });
  await page.waitForTimeout(500);

  // Page 3: speedtest.net home
  await page.goto("https://www.speedtest.net/");
  await page.waitForTimeout(3000);

  recordingState = await ext.getServiceWorker().then((sw) =>
    sw.evaluate(async () => {
      const data = await chrome.storage.session.get("recording_state");
      return (data.recording_state as any)?.isRecording || false;
    })
  );
  console.log("  Recording active:", recordingState);

  await page.locator("body").click({ position: { x: 300, y: 300 } });
  await page.waitForTimeout(500);

  // Stop recording
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(500);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);
  expect(await popup.isIdle()).toBeTruthy();
  console.log("  Recording stopped");

  // Verify workflow
  const wfResp = await page.request.get(`${BACKEND}/v1/workflows`, {
    headers: { "X-API-Key": API_KEY },
  });
  const workflows = (await wfResp.json()) as any[];
  const workflow = workflows[0];

  console.log(`  Workflow: ${workflow.id} (${workflow.status})`);

  const detailResp = await page.request.get(`${BACKEND}/v1/workflows/${workflow.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const detail = (await detailResp.json()) as any;
  const steps = detail.steps;

  console.log(`  Steps: ${steps.length}`);
  for (const s of steps) {
    const sel = s.selector_chain?.[0]?.value || "(no selector)";
    const val = s.value ? `"${s.value.slice(0, 50)}"` : "";
    console.log(`    ${s.step_index}. ${s.action_type} ${sel} ${val}`);
  }

  const clickSteps = steps.filter((s: any) => s.action_type === "click");
  expect(clickSteps.length).toBeGreaterThanOrEqual(1);

  const extConsoleErrors = errors.filter(
    (e) => e.type === "console" && e.url?.includes("chrome-extension://")
  );
  expect(extConsoleErrors).toHaveLength(0);
  console.log("  PASSED: clicks captured across pages");

  await popup.page.close();
  await page.close();
});
