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
});
