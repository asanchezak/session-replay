import type { ActionEvent, RecordEventResponse, Workflow, AgentPollRequest, AgentPollResponse, AgentResultRequest, AgentResultResponse } from "../shared/types";
import { API_BASE_URL } from "../shared/constants";

const API_BASE_KEY = "apiBaseUrl";
const API_KEY_KEY = "apiKey";
const AI_API_KEY_KEY = "aiApiKey";

export const DEV_DEFAULTS = {
  apiBase: API_BASE_URL,
  apiKey: "dev-api-key-change-in-production",
  aiApiKey: "",
};

export async function getConfig(): Promise<{ apiBase: string; apiKey: string; aiApiKey: string }> {
  try {
    const result = await chrome.storage.session.get([API_BASE_KEY, API_KEY_KEY, AI_API_KEY_KEY]);
    return {
      apiBase: (result[API_BASE_KEY] as string) || DEV_DEFAULTS.apiBase,
      apiKey: (result[API_KEY_KEY] as string) || DEV_DEFAULTS.apiKey,
      aiApiKey: (result[AI_API_KEY_KEY] as string) || DEV_DEFAULTS.aiApiKey,
    };
  } catch {
    return DEV_DEFAULTS;
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

  async recordWorkflow(name: string, targetUrl: string | null, events: ActionEvent[], prompt?: string) {
    return this.request<{ id: string; name: string; status: string; step_count: number }>(
      "POST", "/workflows/record",
      {
        name,
        target_url: targetUrl,
        prompt: prompt || null,
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

  // Upload a binary artifact (e.g. a recording-time screenshot). Reuses the
  // run-scoped artifact endpoint with run_id = workflow_id (run_id has no FK),
  // so recording captures live alongside the workflow with zero schema changes.
  async uploadArtifact(runId: string, stepIndex: number, artifactType: string, blob: Blob, filename: string): Promise<void> {
    const { apiBase, apiKey } = await getConfig();
    const fd = new FormData();
    fd.append("file", blob, filename);
    const url = `${apiBase}/runs/${encodeURIComponent(runId)}/artifacts?step_index=${stepIndex}&artifact_type=${encodeURIComponent(artifactType)}`;
    const response = await fetch(url, { method: "POST", headers: { "X-API-Key": apiKey }, body: fd });
    if (!response.ok) {
      throw new Error(`API POST artifacts: ${response.status} ${await response.text()}`);
    }
  }

  async listWorkflows() {
    return this.request<Array<{ id: string; name: string; status: string; execution_mode?: string }>>("GET", "/workflows");
  }

  async getWorkflow(workflowId: string) {
    return this.request<{
      id: string; name: string; status: string; target_url?: string;
      config?: { anti_bot?: boolean; message_template?: string; message_template_updated_at?: string };
      steps: Array<{
        step_index: number;
        action_type: string;
        selector_chain?: Array<{ type: string; value: string }>;
        value?: string;
        intent?: string;
        methods?: Array<Record<string, unknown>> | null;
        dom_context?: Record<string, unknown> | null;
        success_condition?: Record<string, unknown> | null;
      }>;
    }>("GET", `/workflows/${workflowId}`);
  }

  async runWorkflow(workflowId: string) {
    return this.request<{ id: string; status: string; total_steps: number }>(
      "POST", `/workflows/${workflowId}/run`,
    );
  }

  async expandForEach(runId: string, stepIndex: number) {
    return this.request<{
      steps: Array<Record<string, unknown>>;
      iterations: number;
      items?: string[];
      already_expanded?: boolean;
    }>("POST", `/runs/${runId}/expand-for-each`, { step_index: stepIndex });
  }

  async getRunEvents(runId: string, limit = 200) {
    return this.request<Array<{
      event_type?: string;
      payload?: { step_index?: number; data?: Array<{ profile_urls?: unknown }> };
    }>>("GET", `/runs/${runId}/events?limit=${limit}`);
  }

  async fetchMessageTargets(runId: string) {
    return this.request<{
      targets: Array<{
        profile_url: string;
        name: string;
        headline: string;
        score: number | null;
        recommendation: string | null;
        odoo_url: string | null;
        rendered_message: string;
      }>;
      template: string;
      count: number;
      skipped?: string;
    }>("GET", `/runs/${runId}/message-targets`);
  }

  async reportStepResult(
    runId: string,
    stepIndex: number,
    success: boolean,
    error?: string,
    actionType?: string,
    pageContextError?: string,
    actualUrl?: string,
  ) {
    const body: Record<string, unknown> = { step_index: stepIndex, success };
    if (error !== undefined) body.error = error;
    if (actionType !== undefined) body.action_type = actionType;
    if (pageContextError !== undefined) body.page_context_error = pageContextError;
    if (actualUrl !== undefined) body.actual_url = actualUrl;
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
    try {
      return await this.request("POST", `/runs/${runId}/complete`);
    } catch (err) {
      // The backend can transition the run to 'completed' itself (e.g. goal
      // predicate satisfied) before the extension calls /complete. Treat the
      // resulting 409 'Cannot transition from completed to completed' as a
      // benign no-op so the agent loop doesn't crash with "stopped unexpectedly".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("409") && msg.includes("'completed' to 'completed'")) {
        return { id: runId, status: "completed" } as unknown;
      }
      throw err;
    }
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

  async healStep(
    runId: string, stepIndex: number, domSnippet: string,
    oldSelectors: string[], intent?: string,
    visibleText?: string, pageUrl?: string,
  ) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    const body: Record<string, unknown> = {
      step_index: stepIndex, dom_snippet: domSnippet,
      old_selectors: oldSelectors, intent,
    };
    if (visibleText) body.visible_text = visibleText;
    if (pageUrl) body.page_url = pageUrl;
    return this.request<{ step_index: number; new_selectors: Array<{ type: string; value: string }>; confidence: number; explanation: string }>(
      "POST", `/runs/${runId}/heal-step`,
      body,
      extraHeaders,
    );
  }

  async reportHealResult(runId: string, stepIndex: number, success: boolean, error?: string, newSelectors?: Array<{ type: string; value: string }>) {
    return this.request<{ id: string; status: string; current_step_index: number }>(
      "POST", `/runs/${runId}/heal-result`,
      { step_index: stepIndex, success, error, new_selectors: newSelectors },
    );
  }

  async recoverRun(runId: string, stepIndex: number, error: string, domSnippet?: string) {
    const body: Record<string, unknown> = { step_index: stepIndex, error };
    if (domSnippet) body.dom_snippet = domSnippet;
    return this.request<{ id: string; status: string; current_step_index: number }>(
      "POST", `/runs/${runId}/recover`,
      body,
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

  async cancelRun(runId: string) {
    return this.request<{ id: string; status: string }>("POST", `/runs/${runId}/cancel`);
  }

  async getRun(runId: string) {
    return this.request<{ id: string; status: string; current_step_index: number; total_steps: number }>(
      "GET", `/runs/${runId}`,
    );
  }

  async reportTabClosed(runId: string): Promise<{ id: string; status: string }> {
    return this.request<{ id: string; status: string }>("POST", `/runs/${runId}/tab-closed`);
  }

  async getEvent(eventId: string) {
    return this.request("GET", `/events/${eventId}`);
  }

  async getWorkflowAnalysis(workflowId: string) {
    return this.request<{
      workflow_goal: string | null;
      workflow_summary: string | null;
      confidence_overall: number;
      replay_strategy: string | null;
      is_user_edited: boolean;
      parameters: Array<{
        key: string;
        type: string;
        default: string | null;
        description: string | null;
        confidence: number;
        required: boolean;
      }>;
      phases: Array<{
        phase_index: number;
        phase_name: string;
        phase_goal: string | null;
        start_step_index: number;
        end_step_index: number;
      }>;
      output_spec: {
        type: string;
        schema: unknown;
        confidence: number;
      };
    }>("GET", `/workflows/${workflowId}/analysis`);
  }

  async analyzeWorkflow(workflowId: string) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    return this.request<{
      workflow_goal: string | null;
      confidence_overall: number;
      replay_strategy: string | null;
      parameters: Array<Record<string, unknown>>;
    }>("POST", `/workflows/${workflowId}/analyze`, undefined, extraHeaders);
  }

  async analyzePageFields(
    workflowId: string,
    stepIndex: number,
    req: {
      page_url: string;
      page_title?: string;
      visible_text: string;
      dom_snippet?: string;
    },
  ) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    return this.request<{
      workflow_id: string;
      step_index: number;
      page_url: string;
      page_title?: string;
      suggested_fields: Array<{ key: string; label: string; description?: string; shape?: { kind: string; item_keys: string[] | null } }>;
    }>("POST", `/workflows/${workflowId}/steps/${stepIndex}/analyze-page`, req, extraHeaders);
  }

  async analyzePageSuggestions(req: {
    page_url: string;
    page_title?: string;
    visible_text: string;
    dom_snippet?: string;
    page_snapshots?: Array<{
      section_name: string;
      page_url: string;
      page_title?: string;
      visible_text: string;
      dom_snippet?: string;
      captured_at?: string;
    }>;
  }) {
    const { aiApiKey } = await getConfig();
    const extraHeaders: Record<string, string> = {};
    if (aiApiKey) extraHeaders["X-AI-API-Key"] = aiApiKey;
    return this.request<{
      page_url: string;
      page_title?: string;
      suggested_fields: Array<{
        key: string;
        label: string;
        description?: string;
        shape?: { kind: "scalar" | "string_list" | "record_list" | "unknown"; item_keys: string[] | null };
      }>;
    }>("POST", `/workflows/analyze-page-suggestions`, req, extraHeaders);
  }

  async runWithParams(
    workflowId: string,
    params: Record<string, unknown>,
    executionGoal?: string,
    executionTarget: "browser" | "daemon" = "browser",
    executionOptions?: Record<string, unknown>,
  ) {
    return this.request<{
      id: string;
      status: string;
      current_step_index: number;
      total_steps: number;
      execution_target?: string;
      execution_plan: { strategy: string; mode: string; steps?: Array<Record<string, unknown>>; parameters?: Record<string, unknown>; reason?: string };
    }>("POST", `/workflows/${workflowId}/run-with-params`, {
      runtime_params: params,
      execution_goal: executionGoal || null,
      execution_target: executionTarget,
      execution_options: executionOptions || {},
    });
  }

  async getWorkflowTemplate(workflowId: string) {
    return this.request<{
      version: number;
      is_active: boolean;
      template_data: Record<string, unknown>;
    }>("GET", `/workflows/${workflowId}/template`);
  }

  async reportExtraction(
    runId: string,
    stepIndex: number,
    data: Record<string, unknown>[],
    outputSchema?: Record<string, unknown> | null,
  ) {
    return this.request<{ status: string; records: number }>(
      "POST", `/runs/${runId}/extraction`,
      { step_index: stepIndex, data, output_schema: outputSchema ?? null, url: null },
    );
  }

  async agentPoll(runId: string, req: AgentPollRequest) {
    return this.request<AgentPollResponse>(
      "POST", `/agent/${runId}/poll`,
      req,
    );
  }

  async agentResult(runId: string, req: AgentResultRequest) {
    return this.request<AgentResultResponse>(
      "POST", `/agent/${runId}/result`,
      req,
    );
  }

  async agentDecisions(runId: string) {
    return this.request<Array<{ id: string; payload: Record<string, unknown>; hash: string; created_at: string }>>(
      "GET", `/agent/${runId}/decisions`,
    );
  }

  async agentAction(runId: string, action: string) {
    return this.request<{ accepted: boolean; pending_action: string | null }>(
      "POST", `/agent/${runId}/action`,
      { action },
    );
  }

  async aiExtract(pageContent: string, extractionSchema: Record<string, unknown>) {
    return this.request<{ data: Record<string, unknown> }>(
      "POST", `/extract`,
      { page_content: pageContent, extraction_schema: extractionSchema },
    );
  }
}

export const apiClient = new ApiClient();
