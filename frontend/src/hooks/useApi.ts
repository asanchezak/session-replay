import { useState, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/v1";
const API_KEY = import.meta.env.VITE_API_KEY || "dev-api-key-change-in-production";

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export function useApi() {
  const request = useCallback(async <T>(method: ApiMethod, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    };

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      const message = data?.error?.message || data?.detail?.error?.message || `Request failed: ${response.status}`;
      throw new Error(message);
    }

    return data as T;
  }, []);

  return { request };
}

export function useApiData<T>() {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: false, error: null });

  const fetchData = useCallback(async (method: ApiMethod, path: string, body?: unknown) => {
    setState({ data: null, loading: true, error: null });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      };
      const response = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `Request failed: ${response.status}`);
      setState({ data: data as T, loading: false, error: null });
      return data as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setState({ data: null, loading: false, error: message });
      return null;
    }
  }, []);

  return { ...state, fetchData };
}
