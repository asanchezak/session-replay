/** Tests for `useWorkflows()`. */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorkflows } from "../../src/hooks/useWorkflows";

function withFetch(impl: (url: string) => Promise<Response>) {
  (global as any).fetch = vi.fn((input: RequestInfo | URL) => impl(String(input)));
}

describe("useWorkflows", () => {
  it("fetches /workflows once on mount", async () => {
    let count = 0;
    withFetch(async () => {
      count++;
      return { ok: true, status: 200, json: async () => [{ id: "w-1", name: "x", status: "draft", version: 1 }] } as Response;
    });

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.workflows.length).toBe(1));
    expect(count).toBe(1);
  });

  it.fails("F-M-04: refetch after createWorkflow is not automatic", async () => {
    // Once the hook auto-refetches on a "workflows:created" event (or another
    // mechanism), this expectation flips.
    let count = 0;
    withFetch(async () => {
      count++;
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    renderHook(() => useWorkflows());
    await waitFor(() => expect(count).toBe(1));
    // Simulate external creation event.
    window.dispatchEvent(new CustomEvent("workflows:created"));
    // Today: nothing listens; count stays at 1.
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(2);
  });

  it("exposes refetch", async () => {
    let count = 0;
    withFetch(async () => {
      count++;
      return { ok: true, status: 200, json: async () => [] } as Response;
    });
    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(count).toBe(1));
    result.current.refetch();
    await waitFor(() => expect(count).toBe(2));
  });

  it("deleteAllWorkflows sends DELETE to /workflows", async () => {
    (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ deleted: { workflows: 1 } }) } as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await result.current.deleteAllWorkflows();

    const deleteCalls = (global as any).fetch.mock.calls.filter(
      ([url, init]: [string, RequestInit | undefined]) =>
        (init?.method ?? "GET").toUpperCase() === "DELETE" && url.endsWith("/workflows"),
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it("deleteAllWorkflows throws when the server returns an error", async () => {
    (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE") {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "server down" } }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    const { result } = renderHook(() => useWorkflows());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.deleteAllWorkflows()).rejects.toThrow("server down");
  });
});
