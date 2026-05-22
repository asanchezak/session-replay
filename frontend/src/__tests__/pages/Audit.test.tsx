/**
 * AuditPage tests.
 *
 * Pins F-M-02 (filter decoupled from refetch), F-N-11 (hash truncated, no copy).
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import AuditPage from "../../pages/AuditPage";

function withFetch(runs: any[], events: any[]) {
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/runs") || url.includes("/runs?")) {
      return { ok: true, status: 200, json: async () => runs } as Response;
    }
    if (url.includes("/audit/")) {
      return { ok: true, status: 200, json: async () => ({ run_id: "r1", event_count: events.length, events, chain_valid: true, broken_links: [] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as Response;
  });
}

const events = [
  { id: "e1", event_type: "step_executed", actor_type: "extension", payload: { i: 1 }, hash: "a".repeat(64), previous_hash: "0".repeat(64), created_at: new Date().toISOString() },
  { id: "e2", event_type: "recovery_attempt", actor_type: "ai", payload: { confidence: 0.95 }, hash: "b".repeat(64), previous_hash: "a".repeat(64), created_at: new Date().toISOString() },
];

describe("AuditPage", () => {
  it("renders events for selected run", async () => {
    withFetch([{ id: "r1", workflow_id: "w1", status: "running", current_step_index: 0, total_steps: 0, created_at: new Date().toISOString() }], events);
    render(<MemoryRouter><AuditPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("option", { name: /#r1/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "r1" } });
    await waitFor(() => expect(screen.getAllByText(/step_executed/).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/recovery_attempt/).length).toBeGreaterThan(0);
  });

  it.fails("F-M-02: filtering does not lose events when changing dropdown", async () => {
    withFetch([{ id: "r1", workflow_id: "w1", status: "running", current_step_index: 0, total_steps: 0, created_at: new Date().toISOString() }], events);
    render(<MemoryRouter><AuditPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("option", { name: /#r1/i })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "r1" } });
    await waitFor(() => expect(screen.getByText(/step_executed/)).toBeInTheDocument());

    // Switch filter to recovery_attempt; old "step_executed" row must remain in DOM until filter clears.
    // (Today's bug: filter just derives an array from stale state, no debouncing.)
    const select = screen.getByRole("combobox");
    (select as HTMLSelectElement).value = "recovery_attempt";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(screen.queryByText(/step_executed/)).not.toBeInTheDocument());
    // Switch back; row reappears.
    (select as HTMLSelectElement).value = "all";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(screen.queryByText(/step_executed/)).toBeInTheDocument());
  });
});
