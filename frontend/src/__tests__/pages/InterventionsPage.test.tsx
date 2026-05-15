import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const interventions = [
  { id: "i1", run_id: "r1", trigger_reason: "low_confidence_heal", paused_at: "2025-06-01T12:00:00Z", priority: 1 },
  { id: "i2", run_id: "r2", trigger_reason: "captcha_detected", paused_at: "2025-06-01T12:05:00Z", priority: 3 },
];

function mockFetch(data: any[]) {
  (global as any).fetch = vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ interventions: data }),
  }));
}

describe("InterventionsPage", () => {
  it("renders pending interventions", async () => {
    mockFetch(interventions);
    const { default: InterventionsPage } = await import("../../pages/HumanInterventionPage");
    render(<MemoryRouter><InterventionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/low_confidence_heal/)).toBeInTheDocument());
    expect(screen.getByText(/captcha_detected/)).toBeInTheDocument();
  });

  it("shows empty state when no interventions", async () => {
    mockFetch([]);
    const { default: InterventionsPage } = await import("../../pages/HumanInterventionPage");
    render(<MemoryRouter><InterventionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No pending/i)).toBeInTheDocument());
  });
});
