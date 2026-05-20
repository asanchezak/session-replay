/**
 * Workstream F: verify the "Vision" chip renders in the step timeline when a
 * decision outcome includes screenshot_meta, and stays hidden otherwise.
 *
 * The chip is a small visual indicator that vision was used on a step; the
 * test exercises the fetch → outcomesByStep → conditional render path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import RunDetailPage from "../../pages/RunDetailPage";

interface FetchMatchers {
  runId: string;
  workflowId: string;
  withScreenshot: boolean;
}

const buildRun = (runId: string, workflowId: string) => ({
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
});
