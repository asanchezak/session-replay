import { useState, useCallback, useEffect, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "/v1";
const API_KEY = import.meta.env.VITE_API_KEY;

if (!API_KEY) {
  if (import.meta.env.PROD) {
    throw new Error("VITE_API_KEY environment variable is required");
  } else {
    console.warn("VITE_API_KEY is not set. Set it in .env or your environment.");
  }
}

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

type ApiMethod = "GET" | "POST" | "PUT" | "DELETE";

export function useApi() {
  const request = useCallback(async <T>(method: ApiMethod, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY!,
    };

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
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
  const { request } = useApi();
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const fetchData = useCallback(async (method: ApiMethod, path: string, body?: unknown) => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setState({ data: null, loading: true, error: null });
    try {
      const data = await request<T>(method, path, body, controller.signal);
      setState({ data, loading: false, error: null });
      return data;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null;
      const message = err instanceof Error ? err.message : "Unknown error";
      setState({ data: null, loading: false, error: message });
      return null;
    }
  }, [request]);

  return { ...state, fetchData };
}
