import type { Page, BrowserContext } from "@playwright/test";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";

function extractId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const direct = b.id;
  if (typeof direct === "string" && direct) return direct;
  const nestedWorkflow = b.workflow;
  if (nestedWorkflow && typeof nestedWorkflow === "object") {
    const nestedId = (nestedWorkflow as Record<string, unknown>).id;
    if (typeof nestedId === "string" && nestedId) return nestedId;
  }
  return undefined;
}

export class PopupPage {
  constructor(
    public page: Page,
    public extId: string,
  ) {}

  async open() {
    await this.page.goto(`chrome-extension://${this.extId}/dist/popup.html`);
    await this.page.waitForTimeout(1000);
  }

  async clickRecord() {
    await this.page.click("text=Record Workflow");
    // After clicking Record, the GoalInputView appears. Click Skip to start recording.
    await this.page.waitForTimeout(500);
    const skipBtn = this.page.getByText("Skip");
    if (await skipBtn.isVisible().catch(() => false)) {
      await skipBtn.click();
      await this.page.waitForTimeout(500);
    }
  }

  async clickStop() {
    await this.page.click("text=Stop Recording");
  }

  async isRecording() {
    try {
      await this.page.getByText("Recording...").first().waitFor({ timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async isIdle() {
    try {
      await this.page.getByText("Record Workflow").waitFor({ timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async getStepCount(): Promise<number> {
    // Get only the recording span, not the Stop button
    const span = this.page.locator('span').filter({ hasText: /Recording/ }).first();
    const text = await span.textContent();
    const match = text?.match(/(\d+)/);
    return match ? parseInt(match[1]) : 0;
  }
}

export class DashboardPage {
  constructor(public page: Page) {}

  async goto() {
    await this.page.goto("http://localhost:5173/dashboard");
  }

  async gotoWorkflows() {
    await this.page.goto("http://localhost:5173/workflows");
  }

  async gotoWorkflowDetail(workflowId: string) {
    await this.page.goto(`http://localhost:5173/workflows/${workflowId}`);
  }

  async clickWorkflowByName(name: string) {
    await this.page.click(`text=${name}`);
  }

  async clickRun() {
    await this.page.click("button:has-text('Run')");
  }

  async isWorkflowListed(name: string): Promise<boolean> {
    try {
      await this.page.getByText(name).first().waitFor({ timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}

export class ExtensionHelper {
  constructor(
    private context: BrowserContext,
    private extId: string,
  ) {}

  async openPopup(): Promise<PopupPage> {
    const p = await this.context.newPage();
    const popup = new PopupPage(p, this.extId);
    await popup.open();
    return popup;
  }

  async getServiceWorker() {
    let sw = this.context.serviceWorkers()[0];
    if (!sw) sw = await this.context.waitForEvent("serviceworker", { timeout: 15000 });
    return sw;
  }

  async createWorkflowViaAPI(
    name: string,
    events: Array<{ event_type: string; payload: Record<string, unknown> }>,
  ): Promise<string> {
    const page = await this.context.newPage();
    let lastBody: unknown = null;
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const resp = await page.request.post(`${BACKEND}/v1/workflows/record`, {
        headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
        data: { name, events },
      });
      lastStatus = resp.status();
      lastBody = await resp.json().catch(() => null);
      const workflowId = extractId(lastBody);
      if (resp.ok() && workflowId) {
        await page.close();
        return workflowId;
      }
      if (attempt < 3) {
        await page.waitForTimeout(400 * attempt);
      }
    }
    await page.close();
    throw new Error(
      `createWorkflowViaAPI failed after retries (status=${lastStatus}, body=${JSON.stringify(lastBody)})`,
    );
  }

  async activateWorkflowViaAPI(workflowId: string): Promise<void> {
    const page = await this.context.newPage();
    await page.request.put(`${BACKEND}/v1/workflows/${workflowId}/status`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { status: "active" },
    });
    await page.close();
  }

  async runWorkflowViaAPI(workflowId: string): Promise<string> {
    const page = await this.context.newPage();
    // Activate the workflow first (required before running)
    const activateResp = await page.request.put(`${BACKEND}/v1/workflows/${workflowId}/status`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { status: "active" },
    });
    if (!activateResp.ok()) {
      const body = await activateResp.json().catch(() => null);
      await page.close();
      throw new Error(
        `activate workflow failed (status=${activateResp.status()}, body=${JSON.stringify(body)})`,
      );
    }

    let lastBody: unknown = null;
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const resp = await page.request.post(`${BACKEND}/v1/workflows/${workflowId}/run`, {
        headers: { "X-API-Key": API_KEY },
      });
      lastStatus = resp.status();
      lastBody = await resp.json().catch(() => null);
      const runId = extractId(lastBody);
      if (resp.ok() && runId) {
        await page.close();
        return runId;
      }
      if (attempt < 3) {
        await page.waitForTimeout(400 * attempt);
      }
    }
    await page.close();
    throw new Error(
      `runWorkflowViaAPI failed after retries (status=${lastStatus}, body=${JSON.stringify(lastBody)})`,
    );
  }

  async getRunStatus(runId: string): Promise<string> {
    const page = await this.context.newPage();
    const resp = await page.request.get(`${BACKEND}/v1/runs/${runId}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const body = await resp.json();
    await page.close();
    return body.status;
  }

  async advanceStep(runId: string): Promise<void> {
    const page = await this.context.newPage();
    await page.request.post(`${BACKEND}/v1/runs/${runId}/advance_step`, {
      headers: { "X-API-Key": API_KEY },
    });
    await page.close();
  }
}
