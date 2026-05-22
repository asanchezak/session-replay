/**
 * Tests for `useApi` / `useApiData` (frontend/src/hooks/useApi.ts).
 *
 * Pins F-C-09 (no AbortController on unmount) as xfail.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useApi, useApiData } from "../../src/hooks/useApi";

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  (global as any).fetch = vi.fn(impl);
}

describe("useApi", () => {
  it("GET success returns parsed body", async () => {
    mockFetch(async () => ({
      ok: true, status: 200, json: async () => ({ id: "x" }),
    } as Response));

    const { result } = renderHook(() => useApi());
    const got = await result.current.request<{ id: string }>("GET", "/workflows/x");
    expect(got.id).toBe("x");
  });

  it("non-ok response throws with error.message", async () => {
    mockFetch(async () => ({
      ok: false, status: 404, json: async () => ({ error: { code: "NOT_FOUND", message: "gone" } }),
    } as Response));

    const { result } = renderHook(() => useApi());
    await expect(result.current.request("GET", "/workflows/x")).rejects.toThrowError(/gone/);
  });

  it("falls back to status code message when no error shape", async () => {
    mockFetch(async () => ({
      ok: false, status: 500, json: async () => ({}),
    } as Response));

    const { result } = renderHook(() => useApi());
    await expect(result.current.request("GET", "/x")).rejects.toThrowError(/500/);
  });

  it("401 auth error surfaces the UNAUTHORIZED message", async () => {
    mockFetch(async () => ({
      ok: false, status: 401, json: async () => ({
        error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" },
      }),
    } as Response));

    const { result } = renderHook(() => useApi());
    await expect(result.current.request("GET", "/workflows")).rejects.toThrowError(
      /Invalid or missing API key/,
    );
  });

  it("403 CORS error surfaces the FORBIDDEN message", async () => {
    mockFetch(async () => ({
      ok: false, status: 403, json: async () => ({
        error: { code: "FORBIDDEN", message: "Origin not allowed" },
      }),
    } as Response));

    const { result } = renderHook(() => useApi());
    await expect(result.current.request("GET", "/workflows")).rejects.toThrowError(
      /Origin not allowed/,
    );
  });
});

describe("useApiData", () => {
  it("happy path: loading→data", async () => {
    mockFetch(async () => ({
      ok: true, status: 200, json: async () => [{ id: "a" }],
    } as Response));

    const { result } = renderHook(() => useApiData<{ id: string }[]>());
    await act(async () => {
      await result.current.fetchData("GET", "/runs");
    });
    await waitFor(() => expect(result.current.data).toEqual([{ id: "a" }]));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("error path: loading→error", async () => {
    mockFetch(async () => ({
      ok: false, status: 503, json: async () => ({ error: { code: "UPSTREAM", message: "boom" } }),
    } as Response));

    const { result } = renderHook(() => useApiData<unknown>());
    await act(async () => {
      await result.current.fetchData("GET", "/runs");
    });
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.data).toBeNull();
  });

  it("F-C-09: cancels in-flight fetch on unmount (AbortController)", async () => {
    const abortHits: string[] = [];
    mockFetch(async (_input, init) => {
      init?.signal?.addEventListener("abort", () => abortHits.push("aborted"));
      return new Promise(() => {});  // never resolves
    });

    const { result, unmount } = renderHook(() => useApiData<unknown>());
    act(() => { void result.current.fetchData("GET", "/slow"); });
    unmount();
    expect(abortHits).toContain("aborted");
  });
});
