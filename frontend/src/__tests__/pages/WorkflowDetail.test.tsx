import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkflowDetailPage from "../../pages/WorkflowDetailPage";

const baseWorkflow = {
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
  analysis: null,
};

function mockFetchWorkflow(workflow = baseWorkflow) {
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/workflows/wf-1")) {
      return { ok: true, status: 200, json: async () => workflow } as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as Response;
  });
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/workflows/wf-1"]}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("WorkflowDetailPage", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders steps", async () => {
    mockFetchWorkflow();
    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());
    expect(screen.getByText(/click/)).toBeInTheDocument();
  });

  it("opens the goal modal and can run as recorded from workflow detail", async () => {
    mockFetchWorkflow();
    const popupWindow = {
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    };
    const openSpy = vi.fn(() => popupWindow);
    vi.stubGlobal("open", openSpy);
    const postMessageSpy = vi.spyOn(window, "postMessage");

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Run With Goal" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Run As Recorded" }));

    expect(openSpy).toHaveBeenCalledWith("/runs/pending", "session-replay-run");
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: "DASHBOARD_RUN_WORKFLOW", workflowId: "wf-1" },
      "*",
    );

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "DASHBOARD_RUN_STARTED", runId: "run-123" },
      source: window,
    }));

    await waitFor(() => expect(popupWindow.location.href).toBe("/runs/run-123"));
    expect(popupWindow.close).not.toHaveBeenCalled();
  });

  it("posts DASHBOARD_RUN_WORKFLOW with an execution goal from workflow detail", async () => {
    mockFetchWorkflow();
    vi.stubGlobal("open", vi.fn(() => ({
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    })));
    const postMessageSpy = vi.spyOn(window, "postMessage");

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Run With Goal" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("What should this run accomplish?"), {
      target: { value: "Extract the main heading" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run With Goal" }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: "DASHBOARD_RUN_WORKFLOW",
        workflowId: "wf-1",
        goal: "Extract the main heading",
      },
      "*",
    );
  });

  it("opens the parameter modal instead of immediately posting a run when semantic parameters are required", async () => {
    mockFetchWorkflow({
      ...baseWorkflow,
      analysis: {
        workflow_goal: "Collect search results",
        workflow_summary: "Parameterized workflow",
        confidence_overall: 0.9,
        replay_strategy: "parameterized",
        is_user_edited: false,
        phases: [],
        parameters: [
          {
            key: "target_url",
            type: "string",
            default: "https://example.com",
            description: "Search page URL",
            confidence: 0.9,
            required: true,
          },
        ],
        output_spec: { type: "object", schema: null, confidence: 0.5 },
      },
    });
    const postMessageSpy = vi.spyOn(window, "postMessage");
    vi.stubGlobal("open", vi.fn());

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Run with Parameters" })).toBeInTheDocument());
    expect(screen.getByLabelText("Execution goal (optional)")).toBeInTheDocument();
    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it("posts params and optional goal from the parameter modal", async () => {
    mockFetchWorkflow({
      ...baseWorkflow,
      analysis: {
        workflow_goal: "Collect search results",
        workflow_summary: "Parameterized workflow",
        confidence_overall: 0.9,
        replay_strategy: "parameterized",
        is_user_edited: false,
        phases: [],
        parameters: [
          {
            key: "target_url",
            type: "string",
            default: "https://example.com",
            description: "Search page URL",
            confidence: 0.9,
            required: true,
          },
        ],
        output_spec: { type: "object", schema: null, confidence: 0.5 },
      },
    });
    vi.stubGlobal("open", vi.fn(() => ({
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    })));
    const postMessageSpy = vi.spyOn(window, "postMessage");

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Run with Parameters" })).toBeInTheDocument());
    const targetUrlInputs = screen.getAllByDisplayValue("https://example.com");
    fireEvent.change(targetUrlInputs[targetUrlInputs.length - 1], {
      target: { value: "https://example.com/search" },
    });
    fireEvent.change(screen.getByLabelText("Execution goal (optional)"), {
      target: { value: "Collect the first result" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run Workflow" }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: "DASHBOARD_RUN_WORKFLOW",
        workflowId: "wf-1",
        params: { target_url: "https://example.com/search" },
        goal: "Collect the first result",
      },
      "*",
    );
  });

  it("prefills a connector-backed parameter from preview before run", async () => {
    (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workflows/wf-1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...baseWorkflow,
            analysis: {
              workflow_goal: "Send a job message",
              workflow_summary: "Parameterized workflow",
              confidence_overall: 0.9,
              replay_strategy: "parameterized",
              is_user_edited: false,
              phases: [],
              parameters: [
                {
                  key: "recipient",
                  type: "string",
                  default: "Recorded placeholder",
                  description: "Message body",
                  confidence: 0.9,
                  required: true,
                },
              ],
              output_spec: { type: "object", schema: null, confidence: 0.5 },
            },
            connector_bindings: [
              {
                parameter_key: "recipient",
                workflow_step_index: 1,
                connector_id: "conn-1",
                source_kind: "odoo_latest_job",
                template: "Hi {job_title}",
                job_filters: {},
                enabled: true,
              },
            ],
          }),
        } as Response;
      }
      if (url.includes("/workflows/wf-1/connector-bindings/recipient/preview") && (init?.method || "GET") === "POST") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            preview: {
              parameter_key: "recipient",
              workflow_step_index: 1,
              resolved_value: "Hi Senior Python Engineer",
              source_record: { job_id: "11", job_title: "Senior Python Engineer" },
              connector: { id: "conn-1", name: "Odoo HR", type: "odoo" },
              target_summary: "Step 2 - type: i2",
            },
          }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => [{ id: "conn-1", name: "Odoo HR", type: "odoo", status: "connected" }] } as Response;
    });
    vi.stubGlobal("open", vi.fn(() => ({
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    })));
    const postMessageSpy = vi.spyOn(window, "postMessage");

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Run with Parameters" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/Latest job: Senior Python Engineer/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Run Workflow" }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: "DASHBOARD_RUN_WORKFLOW",
        workflowId: "wf-1",
        params: { recipient: "Hi Senior Python Engineer" },
      },
      "*",
    );
  });

  it("shows an error when the extension never reports that the run started", async () => {
    mockFetchWorkflow();
    const popupWindow = {
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    };
    const openSpy = vi.fn(() => popupWindow);
    vi.stubGlobal("open", openSpy);

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Run As Recorded" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
      await Promise.resolve();
    });

    expect(openSpy).toHaveBeenCalled();
    expect(screen.getByText(/Run did not start/i)).toBeInTheDocument();
    expect(popupWindow.close).toHaveBeenCalled();
  });

  it("shows the bridge failure reason when the extension reports RUN_FAILED", async () => {
    mockFetchWorkflow();
    const popupWindow = {
      closed: false,
      close: vi.fn(),
      location: { href: "/runs/pending" },
    };
    vi.stubGlobal("open", vi.fn(() => popupWindow));

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Run As Recorded" }));

    window.dispatchEvent(new MessageEvent("message", {
      data: { type: "DASHBOARD_RUN_FAILED", error: "Backend rejected this run" },
      source: window,
    }));

    await waitFor(() => expect(screen.getByText(/Backend rejected this run/i)).toBeInTheDocument());
    expect(popupWindow.close).toHaveBeenCalled();
  });

  it("Edit fields modal lets the user remove a field and PUTs the updated step", async () => {
    const extractWorkflow = {
      ...baseWorkflow,
      steps: [
        { step_index: 0, action_type: "navigate", intent: "open profile", selector_chain: null, value: "https://www.linkedin.com/in/wbenafi/", methods: null },
        {
          step_index: 1,
          action_type: "extract",
          intent: "Extract About, Skills",
          selector_chain: null,
          value: "About, Skills",
          methods: [
            {
              kind: "extract_shapes",
              shapes: [
                { key: "about", label: "About", kind: "scalar", item_keys: null },
                { key: "skills", label: "Skills", kind: "string_list", item_keys: null },
              ],
            },
          ],
          dom_context: null,
        },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/workflows/wf-1") && (!init?.method || init.method === "GET")) {
        return { ok: true, status: 200, json: async () => extractWorkflow } as Response;
      }
      if (url.endsWith("/workflows/wf-1/steps") && init?.method === "PUT") {
        return { ok: true, status: 200, json: async () => ({ step_count: 2, steps: [] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as Response;
    });
    (global as any).fetch = fetchMock;

    renderPage();
    await waitFor(() => expect(screen.getByText(/Demo WF/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }));
    await waitFor(() => expect(screen.getByText(/Edit extraction fields/i)).toBeInTheDocument());

    // Remove the "Skills" field.
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(removeButtons[1]);

    fireEvent.click(screen.getByRole("button", { name: "Save fields" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/workflows/wf-1/steps"),
        expect.objectContaining({ method: "PUT" }),
      );
    });

    const putCall = fetchMock.mock.calls.find(([input, init]) => String(input).includes("/workflows/wf-1/steps") && init?.method === "PUT");
    const body = JSON.parse(String(putCall?.[1]?.body || "[]"));
    expect(body[1]).toEqual(
      expect.objectContaining({
        action_type: "extract",
        value: "About",
        methods: [expect.objectContaining({ kind: "extract_shapes", shapes: [expect.objectContaining({ key: "about" })] })],
      }),
    );
  });
});
