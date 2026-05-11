import type { ActionEvent, RecordEventResponse } from "../shared/types";

const API_BASE_KEY = "apiBaseUrl";
const API_KEY_KEY = "apiKey";

async function getConfig(): Promise<{ apiBase: string; apiKey: string }> {
  const defaults = {
    apiBase: "http://localhost:8000/v1",
    apiKey: "dev-api-key-change-in-production",
  };
  try {
    const result = await chrome.storage.session.get([API_BASE_KEY, API_KEY_KEY]);
    return {
      apiBase: (result[API_BASE_KEY] as string) || defaults.apiBase,
      apiKey: (result[API_KEY_KEY] as string) || defaults.apiKey,
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

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { apiBase, apiKey } = await getConfig();
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
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

  async recordEvent(event: ActionEvent): Promise<RecordEventResponse> {
    return this.request<RecordEventResponse>("POST", "/events/record", {
      event_type: event.event_type,
      payload: event.payload,
      page_url: event.page_url,
      page_title: event.page_title,
      run_id: event.run_id,
      actor_type: "extension",
    });
  }

  async getEvent(eventId: string) {
    return this.request("GET", `/events/${eventId}`);
  }
}

export const apiClient = new ApiClient();
