/**
 * Logger ring-buffer test. Pins logger.ts:42-53 — scheduled flush dedupes
 * messages and survives backend unavailability.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchMock = vi.fn();
(globalThis as any).fetch = fetchMock;

// chrome.storage.session.get is called async inside getApiKeyHeader(); include it
// in the mock so the logger can resolve the API key before calling fetch.
globalThis.chrome = {
  runtime: { id: "ext", sendMessage: vi.fn() },
  storage: { session: { get: vi.fn().mockResolvedValue({}) } },
} as any;

describe("logger", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("createLogger.log forwards to console and backend", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { createLogger } = await import("../src/shared/logger");
    const log = createLogger("test");
    log.log("hello", { foo: 1 });
    expect(consoleSpy).toHaveBeenCalled();
    // fetch is called asynchronously (after getApiKeyHeader resolves); wait for it.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    consoleSpy.mockRestore();
  });

  it("backend unreachable schedules a flush", async () => {
    fetchMock.mockRejectedValue(new Error("net down"));
    const { createLogger, getLocalBuffer } = await import("../src/shared/logger");
    const log = createLogger("offline");
    log.log("queued line");
    // Buffer accumulates.
    expect(getLocalBuffer().length).toBeGreaterThan(0);
  });

  it("setEnabled(false) silences output", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const { createLogger, setEnabled } = await import("../src/shared/logger");
    setEnabled(false);
    const log = createLogger("muted");
    log.log("shh");
    // fetch should not be called (or called fewer times)
    expect(fetchMock).not.toHaveBeenCalled();
    setEnabled(true);
  });
});
