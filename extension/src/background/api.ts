import type { ActionEvent, RecordEventResponse, Workflow } from "../shared/types";

const API_BASE_KEY = "apiBaseUrl";
const API_KEY_KEY = "apiKey";
const AI_API_KEY_KEY = "aiApiKey";

async function getConfig(): Promise<{ apiBase: string; apiKey: string; aiApiKey: string }> {
  const defaults = {
    apiBase: "http://localhost:8081/v1",
    apiKey: "dev-api-key-change-in-production",
    aiApiKey: "",
  };
  try {
    const result = await chrome.storage.session.get([API_BASE_KEY, API_KEY_KEY, AI_API_KEY_KEY]);
    return {
      apiBase: (result[API_BASE_KEY] as string) || defaults.apiBase,
      apiKey: (result[API_KEY_KEY] as string) || defaults.apiKey,
      aiApiKey: (result[AI_API_KEY_KEY] as string) || defaults.aiApiKey,
    };
  } catch {
    return defaults;
  }
}

export class ApiClient {
  async setConfig(apiBase: string, apiKey: string): Promise<void> {
    await chrome.storage.session.set({
      [API_BASE_KEY]: apiBase,
      [API_KEY_KEY]: apiKey,
    });
  }

  async setAiApiKey(aiApiKey: string): Promise<void> {
    await chrome.storage.session.set({ [AI_API_KEY_KEY]: aiApiKey });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const { apiBase, apiKey } = await getConfig();
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...extraHeaders,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API ${method} ${path}: ${response.status} ${errorBody}`);
    }

    return response.json() as Promise<T>;
  }

  async recordWorkflow(name: string, targetUrl: string | null, events: ActionEvent[]) {
    return this.request<{ id: string; name: string; status: string; step_count: number }>(
      "POST", "/workflows/record",
      {
        name,
        target_url: targetUrl,
        events: events.map(e => ({
          event_type: e.event_type,
          payload: e.payload,
          page_url: e.page_url,
          page_title: e.page_title,
          timestamp: e.timestamp,
        })),
      },
    );
  }

  async listWorkflows() {
    return this.request<Array<{ id: string; name: string; status: string }>>("GET", "/workflows");
  }

  async getWorkflow(workflowId: string) {
    return this.request<{
      id: string; name: string; status: string; target_url?: string;
      steps: Array<{ step_index: number; action_type: string; selector_chain?: Array<{ type: string; value: string }>; value?: string; intent?: string }>;
    }>("GET", `/workflows/${workflowId}`);
  }

  async runWorkflow(workflowId: string) {
    return this.request<{ id: string; status: string; total_steps: number }>(
      "POST", `/workflows/${workflowId}/run`,
    );
  }

  async reportStepResult(runId: string, stepIndex: number, success: boolean, error?: string, actionType?: string) {
    const body: Record<string, unknown> = { step_index: stepIndex, success };
    if (error !== undefined) body.error = error;
    if (actionType !== undefined) body.action_type = actionType;
    return this.request<{ id: string; status: string; current_step_index: number; error_summary: string | null }>(
      "POST", `/runs/${runId}/step-result`,
      body,
    );
  }

  async failRun(runId: string, error: string) {
    return this.request<{ id: string; status: string; error: string | null }>(
      "POST", `/runs/${runId}/fail`,
      { error },
    );
  }

  async completeRun(runId: string) {
    return this.request("POST", `/runs/${runId}/complete`);
  }

  async recordEvent(event: ActionEvent): Promise<RecordEventResponse> {
    return this.request<RecordEventResponse>("POST", "/events/record", {
      event_type: event.event_type,
      payload: event.payload,
      page_url: event.page_url,
      page_title: event.page_title,
      run_id: event.run_id || null,
      actor_type: "extension",
    });
  }

  async healStep(runId: string, stepIndex: number, domSnippet: string, oldSelectors: string[], intent?: string) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    return this.request<{ step_index: number; new_selectors: Array<{ type: string; value: string }>; confidence: number; explanation: string }>(
      "POST", `/runs/${runId}/heal-step`,
      { step_index: stepIndex, dom_snippet: domSnippet, old_selectors: oldSelectors, intent },
      extraHeaders,
    );
  }

  async reportHealResult(runId: string, stepIndex: number, success: boolean, error?: string, newSelectors?: Array<{ type: string; value: string }>) {
    return this.request<{ id: string; status: string; current_step_index: number }>(
      "POST", `/runs/${runId}/heal-result`,
      { step_index: stepIndex, success, error, new_selectors: newSelectors },
    );
  }

  async recoverRun(runId: string, stepIndex: number, error: string) {
    return this.request<{ id: string; status: string; current_step_index: number }>(
      "POST", `/runs/${runId}/recover`,
      { step_index: stepIndex, error },
    );
  }

  async updateWorkflow(workflowId: string, data: { name?: string; description?: string; prompt?: string; target_url?: string }) {
    return this.request<{ id: string; name: string; prompt: string; status: string; version: number }>(
      "PUT", `/workflows/${workflowId}`, data,
    );
  }

  async generateWorkflowPrompt(workflowId: string) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    return this.request<{ prompt: string; generated: boolean }>(
      "POST", `/workflows/${workflowId}/generate-prompt`,
      undefined,
      extraHeaders,
    );
  }

  async updateStepSelectors(workflowId: string, stepIndex: number, selectorChain: Array<{ type: string; value: string }>) {
    return this.request<{ workflow_id: string; step_index: number; selector_chain: unknown }>(
      "PUT", `/workflows/${workflowId}/steps/${stepIndex}`,
      { selector_chain: selectorChain },
    );
  }

  async pauseRun(runId: string, reason: string, stepIndex: number) {
    return this.request<{ id: string; status: string }>(
      "POST", `/runs/${runId}/pause`,
      { reason, step_index: stepIndex },
    );
  }

  async getEvent(eventId: string) {
    return this.request("GET", `/events/${eventId}`);
  }
}

export const apiClient = new ApiClient();
