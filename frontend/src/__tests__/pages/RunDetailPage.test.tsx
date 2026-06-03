/**
 * Workstream F: verify the "Vision" chip renders in the step timeline when a
 * decision outcome includes screenshot_meta, and stays hidden otherwise.
 *
 * The chip is a small visual indicator that vision was used on a step; the
 * test exercises the fetch → outcomesByStep → conditional render path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import RunDetailPage from "../../pages/RunDetailPage";

interface FetchMatchers {
  runId: string;
  workflowId: string;
  withScreenshot: boolean;
}

const buildRun = (runId: string, workflowId: string, extras: Record<string, unknown> = {}) => ({
  id: runId,
  workflow_id: workflowId,
  workflow_snapshot: {
    workflow: { name: "Test Workflow", target_url: "https://example.com" },
    steps: [{ step_index: 0, action_type: "click", intent: "open menu" }],
  },
  status: "completed",
  current_step_index: 1,
  total_steps: 1,
  started_at: "2026-05-20T00:00:00Z",
  ended_at: "2026-05-20T00:00:05Z",
  ...extras,
});

const buildWorkflow = (id: string) => ({
  id, name: "Test Workflow", status: "active", target_url: "https://example.com",
  steps: [{ step_index: 0, action_type: "click", intent: "open menu" }],
});

const buildOutcomes = (withScreenshot: boolean) => [
  {
    id: "outcome-1",
    step_index: 0,
    decision: "EXECUTE",
    confidence: 0.9,
    actual_outcome: "success",
    latency_ms: 120,
    model: "gpt-4o-mini",
    prompt_hash: "abc",
    reasoning: "looks good",
    screenshot_meta: withScreenshot
      ? { sha256: "f" .repeat(64), width: 1280, height: 720,
          mime: "image/jpeg", byte_size: 73210, trigger: "first_poll", detail: "low" }
      : null,
    created_at: "2026-05-20T00:00:01Z",
    resolved_at: "2026-05-20T00:00:02Z",
  },
];

function installFetch({ runId, workflowId, withScreenshot }: FetchMatchers) {
  (global as any).fetch = vi.fn(async (url: string) => {
    const json = async () => {
      if (url.includes(`/runs/${runId}/events`)) return [];
      if (url.includes(`/runs/${runId}`)) return buildRun(runId, workflowId);
      if (url.includes(`/workflows/${workflowId}`)) return buildWorkflow(workflowId);
      if (url.includes(`/agent/${runId}/outcomes`)) return buildOutcomes(withScreenshot);
      return [];
    };
    return { ok: true, status: 200, json, text: async () => JSON.stringify(await json()) };
  });
}

function renderPage(runId: string) {
  return render(
    <MemoryRouter initialEntries={[`/runs/${runId}`]}>
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RunDetailPage Vision chip", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders the Vision chip when an outcome has screenshot_meta", async () => {
    installFetch({ runId: "run-vision", workflowId: "wf-1", withScreenshot: true });
    renderPage("run-vision");

    const chip = await screen.findByTestId("vision-chip-step-0", {}, { timeout: 5000 });
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent("Vision");
    expect(chip.getAttribute("title")).toMatch(/1280×720/);
    expect(chip.getAttribute("title")).toMatch(/first_poll/);
    expect(chip.getAttribute("aria-label")).toMatch(/Vision: AI received a screenshot/);
  });

  it("opens the new run in a new tab when Re-run is clicked on a terminal run", async () => {
    const sourceRunId = "run-source-1";
    const newRunId = "run-clone-1";
    const workflowId = "wf-rerun-1";

    (global as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const isPost = (init?.method || "GET").toUpperCase() === "POST";
      const json = async () => {
        if (isPost && url.includes(`/runs/${sourceRunId}/rerun`)) {
          return {
            id: newRunId,
            workflow_id: workflowId,
            status: "running",
            current_step_index: 0,
            total_steps: 1,
            rerun_of: sourceRunId,
          };
        }
        if (url.includes(`/runs/${sourceRunId}/events`)) return [];
        if (url.includes(`/runs/${sourceRunId}`)) return buildRun(sourceRunId, workflowId);
        if (url.includes(`/workflows/${workflowId}`)) return buildWorkflow(workflowId);
        if (url.includes(`/agent/${sourceRunId}/outcomes`)) return buildOutcomes(false);
        return [];
      };
      return { ok: true, status: 200, json, text: async () => JSON.stringify(await json()) };
    });

    // Synchronously stub window.open so the click handler captures the tab
    // before the async API call resolves (pop-up blocker friendly path).
    const fakeTab = { location: { href: "" }, closed: false } as any;
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab);

    renderPage(sourceRunId);

    const button = await screen.findByRole("button", { name: /Re-run/i }, { timeout: 5000 });
    fireEvent.click(button);

    // The blank tab must be opened synchronously inside the click handler.
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");

    // Once the rerun POST resolves, the tab's location is redirected to /runs/<newId>.
    await waitFor(
      () => expect(fakeTab.location.href).toContain(`/runs/${newRunId}`),
      { timeout: 5000 },
    );

    openSpy.mockRestore();
  });

  it("renders connector resolution details when the run used a connector-backed parameter", async () => {
    const runId = "run-connector-1";
    const workflowId = "wf-connector-1";
    (global as any).fetch = vi.fn(async (url: string) => {
      const json = async () => {
        if (url.includes(`/runs/${runId}/events`)) return [];
        if (url.includes(`/runs/${runId}`)) {
          return buildRun(runId, workflowId, {
            resolved_parameters: { recipient: "Hi Senior Python Engineer" },
            connector_resolution: [
              {
                parameter_key: "recipient",
                resolved_value: "Hi Senior Python Engineer",
                connector: { name: "Odoo HR", type: "odoo" },
                source_record: { job_id: "11", job_title: "Senior Python Engineer" },
              },
            ],
          });
        }
        if (url.includes(`/workflows/${workflowId}`)) return buildWorkflow(workflowId);
        if (url.includes(`/agent/${runId}/outcomes`)) return buildOutcomes(false);
        return [];
      };
      return { ok: true, status: 200, json, text: async () => JSON.stringify(await json()) };
    });

    renderPage(runId);

    expect(await screen.findByText("Connector Resolution")).toBeInTheDocument();
    expect(screen.getByText("Latest job: Senior Python Engineer (#11)")).toBeInTheDocument();
    expect(screen.getByText("Hi Senior Python Engineer")).toBeInTheDocument();
  });

  it("does not render the Vision chip when screenshot_meta is null", async () => {
    installFetch({ runId: "run-text-only", workflowId: "wf-2", withScreenshot: false });
    renderPage("run-text-only");

    // Wait for the page to settle by waiting for a stable element.
    await waitFor(
      () => expect(screen.queryByText(/Test Workflow/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );

    // Now confirm the chip is absent.
    expect(screen.queryByTestId("vision-chip-step-0")).not.toBeInTheDocument();
  });

  it("renders an error banner when the first run fetch fails", async () => {
    (global as any).fetch = vi.fn(async (url: string) => {
      if (url.includes("/runs/run-missing/events")) {
        return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
      }
      if (url.includes("/agent/run-missing/outcomes")) {
        return { ok: true, status: 200, json: async () => [], text: async () => "[]" } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: { code: "NOT_FOUND", message: "Run not found" } }),
        text: async () => JSON.stringify({ error: { code: "NOT_FOUND", message: "Run not found" } }),
      } as Response;
    });

    renderPage("run-missing");

    expect(await screen.findByText("Error loading run")).toBeInTheDocument();
    expect(screen.getByText("Run not found")).toBeInTheDocument();
  });
});
