/**
 * WorkflowDetailPage tests.
 *
 * Pins F-M-05: handleRun uses hardcoded API key + no error UI.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import WorkflowDetailPage from "../../src/pages/WorkflowDetailPage";

const workflow = {
  id: "wf-1",
  name: "Demo WF",
  description: "test",
  prompt: "do x",
  target_url: "https://x.example",
  status: "active",
  version: 1,
  created_at: new Date().toISOString(),
  steps: [
    { step_index: 0, action_type: "click", intent: "i1", selector_chain: [{ type: "css", value: "#btn" }], value: null, methods: null },
    { step_index: 1, action_type: "type", intent: "i2", selector_chain: [{ type: "css", value: "#field" }], value: "hello", methods: null },
  ],
};

function mockFetchWorkflowAndRun(runStatus = 200) {
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/workflows/wf-1")) {
      return { ok: true, status: 200, json: async () => workflow } as Response;
    }
    if (url.endsWith("/workflows/wf-1/run") || url.endsWith("/runs")) {
      return { ok: runStatus === 200, status: runStatus, json: async () => ({ id: "run-1", status: "running", total_steps: 2 }) } as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as Response;
  });
}

describe("WorkflowDetailPage", () => {
  it("renders steps", async () => {
    mockFetchWorkflowAndRun();
    render(
      <MemoryRouter initialEntries={["/workflows/wf-1"]}>
        <Routes>
          <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());
    expect(screen.getByText(/click/)).toBeInTheDocument();
  });

  it.fails("F-M-05: run failure surfaces an error toast", async () => {
    mockFetchWorkflowAndRun(503);
    render(
      <MemoryRouter initialEntries={["/workflows/wf-1"]}>
        <Routes>
          <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());
    // Click Run; expect error message in the UI.
    const btn = screen.getByRole("button", { name: /run/i });
    btn.click();
    await waitFor(() => expect(screen.getByText(/failed|error|503/i)).toBeInTheDocument());
  });
});
