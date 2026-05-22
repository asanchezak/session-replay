import { useState, useCallback, useEffect, useRef } from "react";
import { logger } from "../lib/logger";

const API_BASE = import.meta.env.VITE_API_URL || "/v1";
const API_KEY = import.meta.env.VITE_API_KEY;
const LOADING_TIMEOUT_MS = 15000;

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
    const start = performance.now();
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

    const elapsed = performance.now() - start;
    const headerGet =
      response.headers && typeof response.headers.get === "function"
        ? (name: string) => response.headers.get(name)
        : (_name: string) => null;
    const contentLength = headerGet("content-length");
    const contentType = (headerGet("content-type") || "").toLowerCase();

    let data: unknown = null;
    if (response.status !== 204 && contentLength !== "0") {
      if (contentType.includes("application/json") || contentType === "") {
        try {
          data = await response.json();
        } catch {
          data = null;
        }
      } else {
        try {
          const text = await response.text();
          data = text ? { raw: text } : null;
        } catch {
          data = null;
        }
      }
    }

    logger.apiCall("useApi", method, path, response.status, elapsed);

    if (!response.ok) {
      const errorBody = data as { error?: { message?: string; code?: string; details?: unknown }; detail?: { error?: { message?: string } } } | null;
      const message =
        errorBody?.error?.message ||
        errorBody?.detail?.error?.message ||
        `Request failed: ${response.status}`;
      logger.error("useApi", `${method} ${path}`, {
        status_code: response.status,
        error_code: errorBody?.error?.code,
        error_details: errorBody?.error?.details,
        response_body: JSON.stringify(data).slice(0, 500),
      });
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
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const fetchData = useCallback(async (method: ApiMethod, path: string, body?: unknown) => {
    abortControllerRef.current?.abort();
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setState({ data: null, loading: true, error: null });

    const timeoutId = setTimeout(() => {
      controller.abort();
      setState(prev => prev.loading ? { data: null, loading: false, error: "Request timed out. Is the backend running?" } : prev);
    }, LOADING_TIMEOUT_MS);
    timeoutRef.current = timeoutId;

    try {
      const data = await request<T>(method, path, body, controller.signal);
      clearTimeout(timeoutId);
      setState({ data, loading: false, error: null });
      return data;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") return null;
      const message = err instanceof Error ? err.message : "Unknown error";
      setState({ data: null, loading: false, error: message });
      return null;
    }
  }, [request]);

  return { ...state, fetchData };
}
