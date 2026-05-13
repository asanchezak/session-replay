/**
 * DashboardPage tests.
 *
 * Pins F-M-01: failed-run banner shows ALL failures, not just 2.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import DashboardPage from "../../src/pages/DashboardPage";

function setupFetch(workflows: unknown[], runs: unknown[]) {
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/workflows")) {
      return { ok: true, status: 200, json: async () => workflows } as Response;
    }
    if (url.endsWith("/runs") || url.includes("/runs?")) {
      return { ok: true, status: 200, json: async () => runs } as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as Response;
  });
}

describe("DashboardPage", () => {
  it("renders KPIs from workflows + runs", async () => {
    setupFetch(
      [{ id: "w1", name: "wf1", status: "active", version: 1, created_at: new Date().toISOString() }],
      [
        { id: "r1", workflow_id: "w1", status: "running", current_step_index: 1, total_steps: 5, created_at: new Date().toISOString() },
        { id: "r2", workflow_id: "w1", status: "failed", current_step_index: 3, total_steps: 5, created_at: new Date().toISOString(), error_summary: "boom" },
      ],
    );

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText(/wf1/i) || screen.queryByText(/running/i)).toBeTruthy());
  });

  it.fails("F-M-01: requires-attention banner lists ALL failed runs, not just 2", async () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `r-${i}`,
      workflow_id: "w1",
      status: "failed",
      current_step_index: i,
      total_steps: 10,
      created_at: new Date().toISOString(),
      error_summary: `err-${i}`,
    }));
    setupFetch([{ id: "w1", name: "x", status: "active", version: 1, created_at: new Date().toISOString() }], runs);

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    // Today the banner is capped at 2 items. Once the cap is removed, all 10 appear.
    await waitFor(() => {
      const items = screen.queryAllByText(/err-/);
      expect(items.length).toBe(10);
    });
  });
});
