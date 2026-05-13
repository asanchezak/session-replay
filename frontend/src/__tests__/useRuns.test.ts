/**
 * Tests for `useRuns(workflowId?)`.
 *
 * Pins F-M-03: when `workflowId` changes the previous fetch is not cancelled.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useRuns } from "../../src/hooks/useRuns";

function withFetch(impl: (url: string) => Promise<Response>) {
  (global as any).fetch = vi.fn((input: RequestInfo | URL) => impl(String(input)));
}

describe("useRuns", () => {
  it("fetches /runs on mount when no workflowId", async () => {
    const seen: string[] = [];
    withFetch(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    renderHook(() => useRuns());
    await waitFor(() => expect(seen.some((u) => u.endsWith("/runs"))).toBe(true));
  });

  it("fetches /runs?workflow_id=... when workflowId passed", async () => {
    const seen: string[] = [];
    withFetch(async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    renderHook(() => useRuns("wf-1"));
    await waitFor(() => expect(seen.some((u) => u.includes("workflow_id=wf-1"))).toBe(true));
  });

  it("refetch fires another fetch", async () => {
    let count = 0;
    withFetch(async () => {
      count++;
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    const { result } = renderHook(() => useRuns());
    await waitFor(() => expect(count).toBe(1));
    result.current.refetch();
    await waitFor(() => expect(count).toBe(2));
  });

  it.fails("F-M-03: stale response from previous workflowId does not overwrite fresh one", async () => {
    let respond: ((v: unknown) => void) | null = null;
    withFetch(async (url) => {
      if (url.includes("wf-1")) {
        return new Promise((resolve) => {
          respond = (data) => resolve({ ok: true, status: 200, json: async () => data } as Response);
        });
      }
      return { ok: true, status: 200, json: async () => [{ id: "fresh" }] } as Response;
    });

    const { result, rerender } = renderHook(({ id }: { id: string }) => useRuns(id), { initialProps: { id: "wf-1" } });
    // Switch to wf-2 BEFORE wf-1's response arrives.
    rerender({ id: "wf-2" });
    // Now wf-1 responds (late).
    respond?.([{ id: "stale" }]);

    // Once F-M-03 is fixed (AbortController on previous fetch), result.runs must NOT contain "stale".
    await waitFor(() => expect(result.current.runs.find((r: any) => r.id === "fresh")).toBeTruthy());
    expect(result.current.runs.find((r: any) => r.id === "stale")).toBeUndefined();
  });
});
