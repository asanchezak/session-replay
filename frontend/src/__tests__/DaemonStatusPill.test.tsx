import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import DaemonStatusPill from "../components/DaemonStatusPill";

function renderPill() {
  return render(
    <MemoryRouter>
      <DaemonStatusPill />
    </MemoryRouter>,
  );
}

describe("DaemonStatusPill", () => {
  it("renders green when a worker is up and idle", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        any_up: true,
        workers: [{
          worker_id: "worker-a",
          polling: true,
          driving_run_id: null,
          last_seen: "2026-05-27T12:00:00Z",
          age_seconds: 2,
          up: true,
        }],
      }),
    }));

    renderPill();

    await waitFor(() => expect(screen.getByLabelText("Daemon is up")).toBeInTheDocument());
    expect(screen.getByText("Daemon up")).toBeInTheDocument();
  });

  it("renders yellow and links to the active run when a worker is driving", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        any_up: true,
        workers: [{
          worker_id: "worker-a",
          polling: false,
          driving_run_id: "run-123",
          last_seen: "2026-05-27T12:00:00Z",
          age_seconds: 1,
          up: true,
        }],
      }),
    }));

    renderPill();

    const link = await screen.findByRole("link", { name: "Daemon driving an active run" });
    expect(link).toHaveAttribute("href", "/runs/run-123");
    expect(screen.getByText("Daemon driving run")).toBeInTheDocument();
  });

  it("renders a walled-seat warning when an up worker's last ping was walled", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        any_up: true,
        workers: [{
          worker_id: "fernanda",
          polling: true,
          driving_run_id: null,
          seat_warm: false,
          seat_checked_at: "2026-07-07T15:40:00Z",
          last_seen: "2026-07-07T15:41:00Z",
          age_seconds: 2,
          up: true,
        }],
      }),
    }));

    renderPill();

    await waitFor(() => expect(screen.getByLabelText("Recruiter seat walled")).toBeInTheDocument());
    expect(screen.getByText("Seat walled · re-login")).toBeInTheDocument();
  });

  it("renders red with relative age when workers are stale", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        any_up: false,
        workers: [{
          worker_id: "worker-a",
          polling: true,
          driving_run_id: null,
          last_seen: "2026-05-27T12:00:00Z",
          age_seconds: 42,
          up: false,
        }],
      }),
    }));

    renderPill();

    await waitFor(() => expect(screen.getByLabelText("Daemon is down")).toBeInTheDocument());
    expect(screen.getByText("Daemon down · last seen 42s ago")).toBeInTheDocument();
  });

  it("renders red without age when no workers have reported", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ any_up: false, workers: [] }),
    }));

    renderPill();

    await waitFor(() => expect(screen.getByText("Daemon down")).toBeInTheDocument());
  });
});
