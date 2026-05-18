import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateSpy = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import DashboardPage from "../../pages/DashboardPage";

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
  beforeEach(() => {
    navigateSpy.mockReset();
  });

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

  it("requires-attention banner lists up to 10 failed runs and exposes the remainder link", async () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({
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

    await waitFor(() => {
      const items = screen.queryAllByText(/err-/);
      expect(items.length).toBe(10);
    });
    expect(screen.getByRole("button", { name: /View all 2 more failed runs/i })).toBeInTheDocument();
  });

  it("recent run cards navigate to the run detail page", async () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({
      id: `r-${i}`,
      workflow_id: "w1",
      status: i === 0 ? "running" : "failed",
      current_step_index: i,
      total_steps: 10,
      created_at: new Date().toISOString(),
      error_summary: `err-${i}`,
    }));
    setupFetch([{ id: "w1", name: "x", status: "active", version: 1, created_at: new Date().toISOString() }], runs);

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);
    const runCard = await screen.findByText("Run #r-0");
    fireEvent.click(runCard);
    expect(navigateSpy).toHaveBeenCalledWith("/runs/r-0");
  });

  it("shows a load error banner when the API request fails", async () => {
    (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/workflows")) {
        return { ok: false, status: 502, json: async () => ({ error: { message: "workflow fetch failed" } }) } as Response;
      }
      if (url.endsWith("/runs") || url.includes("/runs?")) {
        return { ok: false, status: 503, json: async () => ({ error: { message: "run fetch failed" } }) } as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as Response;
    });

    render(<MemoryRouter><DashboardPage /></MemoryRouter>);

    await waitFor(() => {
      expect(screen.getByText("Unable to load dashboard data")).toBeInTheDocument();
    });
    expect(screen.getByText(/workflow fetch failed run fetch failed/i)).toBeInTheDocument();
  });
});
