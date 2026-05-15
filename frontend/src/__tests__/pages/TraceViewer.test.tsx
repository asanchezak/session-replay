import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mockEvents = [
  { id: "e1", event_type: "run_started", actor_type: "system", payload: { workflow_id: "w1" }, hash: "a".repeat(64), previous_hash: "0".repeat(64), created_at: "2025-06-01T12:00:00Z" },
  { id: "e2", event_type: "step_executed", actor_type: "extension", payload: { step_index: 0, action_type: "click" }, hash: "b".repeat(64), previous_hash: "a".repeat(64), created_at: "2025-06-01T12:00:01Z" },
  { id: "e3", event_type: "recovery_attempt", actor_type: "ai", payload: { confidence: 0.95 }, hash: "c".repeat(64), previous_hash: "b".repeat(64), created_at: "2025-06-01T12:00:02Z" },
];

function mockFetch(events: any[]) {
  (global as any).fetch = vi.fn(async (url: string) => {
    if (url.includes("/audit/") || url.includes("/events")) {
      return { ok: true, status: 200, json: async () => ({ events, chain_valid: true, broken_links: [] }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
}

describe("TraceViewer", () => {
  beforeEach(() => { mockFetch(mockEvents); });

  it("renders events in timeline", async () => {
    const { default: TraceViewer } = await import("../../pages/TracePage");
    render(<MemoryRouter initialEntries={["/runs/r1/trace"]}><Routes><Route path="/runs/:id/trace" element={<TraceViewer />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/run_started/)).toBeInTheDocument());
    expect(screen.getByText(/step_executed/)).toBeInTheDocument();
    expect(screen.getByText(/recovery_attempt/)).toBeInTheDocument();
  });

  it("shows empty state when no events", async () => {
    mockFetch([]);
    const { default: TraceViewer } = await import("../../pages/TracePage");
    render(<MemoryRouter initialEntries={["/runs/r1/trace"]}><Routes><Route path="/runs/:id/trace" element={<TraceViewer />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No audit events/i)).toBeInTheDocument());
  });

  it("displays hash field for each event", async () => {
    const { default: TraceViewer } = await import("../../pages/TracePage");
    render(<MemoryRouter initialEntries={["/runs/r1/trace"]}><Routes><Route path="/runs/:id/trace" element={<TraceViewer />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/aaaa/)).toBeInTheDocument());
  });
});
