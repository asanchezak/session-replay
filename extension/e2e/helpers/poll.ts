import type { Page } from "@playwright/test";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

export async function pollRunStatus(
  page: Page,
  runId: string,
  options?: { timeout?: number; interval?: number },
): Promise<any> {
  const timeout = options?.timeout ?? 120_000;
  const interval = options?.interval ?? 2000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const resp = await page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const run = await resp.json() as any;
    if (["completed", "failed", "canceled", "waiting_for_user"].includes(run.status)) {
      return run;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Run ${runId} did not reach terminal state within ${timeout}ms`);
}

export async function getAudit(page: Page, runId: string): Promise<any[]> {
  const resp = await page.request.get(`${BACKEND}/v1/audit/${runId}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const data = await resp.json() as any;
  const events = Array.isArray(data) ? data : (data.events || []);
  return events;
}

export async function setAiApiKey(sw: any, key: string): Promise<void> {
  await sw.evaluate(async (k: string) => {
    await chrome.storage.session.set({ aiApiKey: k });
  }, key);
}
