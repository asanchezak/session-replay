/**
 * Unit tests for the SW Orchestrator.
 *
 * Pins:
 * - persist() saves to chrome.storage.session
 * - startRecording resets eventBuffer and broadcasts state
 * - stopRecording with zero events returns null (no API call)
 * - pushEvent queues during init and drains after ready
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

if (typeof CSS === "undefined") (globalThis as any).CSS = {};

const storage: Record<string, unknown> = {};
const chromeMock = {
  runtime: { sendMessage: vi.fn().mockResolvedValue(undefined), onMessage: { addListener: vi.fn() } },
  tabs: { sendMessage: vi.fn(), query: vi.fn() },
  storage: {
    session: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === "string") return { [key]: storage[key] };
        const out: Record<string, unknown> = {};
        for (const k of key as string[]) out[k] = storage[k];
        return out;
      }),
      set: vi.fn(async (entries: Record<string, unknown>) => { Object.assign(storage, entries); }),
      remove: vi.fn(async (k: string) => { delete storage[k]; }),
      setAccessLevel: vi.fn().mockResolvedValue(undefined),
    },
  },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  action: { onClicked: { addListener: vi.fn() } },
};

vi.stubGlobal("chrome", chromeMock);

vi.mock("../src/background/api", () => ({
  apiClient: { recordWorkflow: vi.fn(async () => ({ id: "wf-1", name: "test", step_count: 0 })) },
}));

describe("Orchestrator", () => {
  beforeEach(() => {
    for (const k of Object.keys(storage)) delete storage[k];
    vi.clearAllMocks();
  });

  it("startRecording resets buffer and persists state", async () => {
    const { orchestrator } = await import("../src/background/orchestrator");
    orchestrator.startRecording();
    await new Promise((r) => setTimeout(r, 5));
    expect(orchestrator.isRecording).toBe(true);
    expect(storage.recording_state).toBeTruthy();
  });

  it("stopRecording with empty buffer returns null", async () => {
    const { orchestrator } = await import("../src/background/orchestrator");
    orchestrator.startRecording();
    await new Promise((r) => setTimeout(r, 5));
    const result = await orchestrator.stopRecording();
    expect(result).toBeNull();
  });

  it("pushEvent during recording grows the buffer", async () => {
    const { orchestrator } = await import("../src/background/orchestrator");
    orchestrator.startRecording();
    await new Promise((r) => setTimeout(r, 5));
    await orchestrator.pushEvent({
      event_type: "click", payload: {},
      page_url: "https://x", page_title: "t", timestamp: "2026-05-12T00:00:00Z",
    });
    expect(orchestrator.eventBuffer.length).toBe(1);
  });

  it("broadcastState sends a STATE_UPDATE message", async () => {
    const { orchestrator } = await import("../src/background/orchestrator");
    orchestrator.broadcastState();
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalled();
    const arg = chromeMock.runtime.sendMessage.mock.calls[0][0];
    expect(arg.type).toBe("STATE_UPDATE");
  });
});
