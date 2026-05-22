/**
 * SettingsPage persistence — pins F-C-01.
 *
 * Today `handleSave` only toasts. The test expects an actual POST to a
 * `/v1/settings` endpoint with the chosen values. When the persistence
 * lands, the xfail flips.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import SettingsPage from "../../pages/SettingsPage";

describe("SettingsPage", () => {
  it.fails("F-C-01: save persists values via POST /v1/settings", async () => {
    const calls: string[] = [];
    (global as any).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /save all settings/i }));
    await waitFor(() => {
      expect(calls.some((c) => c.startsWith("POST") && c.includes("/settings"))).toBe(true);
    });
  });

  it("renders the four cards", () => {
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: /^Policies$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Retention$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^API Keys$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Notifications$/i })).toBeInTheDocument();
  });

  it("shows the success banner after clicking Save", async () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /save all settings/i }));
    await waitFor(() => expect(screen.getByText(/Settings saved/i)).toBeInTheDocument());
  });
});
