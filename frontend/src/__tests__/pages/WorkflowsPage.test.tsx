import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigateSpy = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateSpy };
});

import WorkflowsPage from "../../pages/WorkflowsPage";

const sampleWorkflows = [
  { id: "wf-1", name: "Alpha Workflow", status: "active", version: 1, created_at: new Date().toISOString() },
  { id: "wf-2", name: "Beta Workflow", status: "draft", version: 1, created_at: new Date().toISOString() },
];

type SetupOpts = { initialWorkflows?: unknown[]; deleteOk?: boolean };

function setupFetch({ initialWorkflows = sampleWorkflows, deleteOk = true }: SetupOpts = {}) {
  let deleted = false;
  (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "DELETE" && url.endsWith("/workflows")) {
      if (deleteOk) deleted = true;
      return {
        ok: deleteOk,
        status: deleteOk ? 200 : 500,
        json: async () =>
          deleteOk
            ? { deleted: { workflows: initialWorkflows.length, workflow_steps: 0 } }
            : { error: { message: "Internal server error" } },
      } as Response;
    }
    if (url.endsWith("/workflows")) {
      return {
        ok: true,
        status: 200,
        json: async () => (deleted ? [] : initialWorkflows),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => [] } as Response;
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <WorkflowsPage />
    </MemoryRouter>,
  );
}

describe("WorkflowsPage — delete all", () => {
  beforeEach(() => {
    navigateSpy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hides the delete-all button when there are no workflows", async () => {
    setupFetch({ initialWorkflows: [] });
    renderPage();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Delete all/i })).not.toBeInTheDocument();
  });

  it("shows the delete-all button with the workflow count", async () => {
    setupFetch();
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all \(2\)/i })).toBeInTheDocument(),
    );
  });

  it("does nothing when the user cancels the confirm dialog", async () => {
    setupFetch();
    vi.stubGlobal("confirm", vi.fn(() => false));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete all/i }));
    const deleteCalls = (global as any).fetch.mock.calls.filter(
      ([, init]: [unknown, RequestInit | undefined]) =>
        (init?.method ?? "GET").toUpperCase() === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
  });

  it("sends DELETE /workflows and refetches on confirm", async () => {
    setupFetch();
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete all/i }));
    await waitFor(() => {
      const deleteCalls = (global as any).fetch.mock.calls.filter(
        ([url, init]: [string, RequestInit | undefined]) =>
          (init?.method ?? "GET").toUpperCase() === "DELETE" && url.endsWith("/workflows"),
      );
      expect(deleteCalls).toHaveLength(1);
    });
    // Refetch returns empty list → empty state is shown
    await waitFor(() => expect(screen.getByText(/No workflows yet/i)).toBeInTheDocument());
    // Button disappears once the list is empty
    expect(screen.queryByRole("button", { name: /Delete all/i })).not.toBeInTheDocument();
  });

  it("disables the button while deletion is in-flight", async () => {
    let resolveDelete!: () => void;
    const pending = new Promise<void>((res) => { resolveDelete = res; });

    (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && url.endsWith("/workflows")) {
        await pending;
        return { ok: true, status: 200, json: async () => ({ deleted: {} }) } as Response;
      }
      return { ok: true, status: 200, json: async () => sampleWorkflows } as Response;
    });

    vi.stubGlobal("confirm", vi.fn(() => true));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete all/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Deleting/i })).toBeDisabled(),
    );
    resolveDelete();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Deleting/i })).not.toBeInTheDocument(),
    );
  });

  it("re-enables the button after a failed delete", async () => {
    setupFetch({ deleteOk: false });
    vi.stubGlobal("confirm", vi.fn(() => true));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Delete all/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Delete all \(2\)/i })).not.toBeDisabled(),
    );
  });
});
