import type { Page } from "@playwright/test";

const BACKEND = "http://localhost:8081";
const API_KEY = "dev-api-key-change-in-production";

type Selector = { type: string; value: string };

export class DeterministicHealProvider {
  private selectorMap: Map<string, Selector> = new Map();
  private defaultResponse: Record<string, unknown>;

  constructor(defaultResponse?: Record<string, unknown>) {
    this.defaultResponse = defaultResponse || {
      selector: "#mock-selector",
      fallback_selectors: [{ type: "css", value: "#mock-selector" }],
      confidence: 0.85,
      explanation: "Test provider — deterministic response",
    };
  }

  addMapping(oldSelector: string, newType: string, newValue: string): void {
    this.selectorMap.set(oldSelector, { type: newType, value: newValue });
  }

  private buildResponseForOldSelectors(oldSelectors: string[]): Record<string, unknown> {
    for (const old of oldSelectors) {
      const entry = this.selectorMap.get(old);
      if (entry) {
        return {
          selector: entry.value,
          fallback_selectors: [entry],
          confidence: 0.85,
          explanation: "Test provider — selector mapped",
        };
      }
    }
    return this.defaultResponse;
  }

  async injectForRun(page: Page, key: string, oldSelectors: string[]): Promise<void> {
    const response = this.buildResponseForOldSelectors(oldSelectors);
    await page.request.post(`${BACKEND}/v1/runs/testing/inject-heal-override`, {
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      data: { run_id: key, response },
    });
  }

  async clearAll(page: Page): Promise<void> {
    await page.request.post(`${BACKEND}/v1/runs/testing/clear-heal-overrides`, {
      headers: { "X-API-Key": API_KEY },
    });
  }
}
