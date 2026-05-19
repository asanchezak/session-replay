import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal Chrome API surface for CommandExecutor.captureScreenshot.
// captureVisibleTab returns a data URL; we control its content per test.
const captureVisibleTab = vi.fn<(windowId: number, opts: any) => Promise<string | null>>();
const tabsGet = vi.fn<(tabId: number) => Promise<chrome.tabs.Tab>>();

globalThis.chrome = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    captureVisibleTab,
    get: tabsGet,
  },
  storage: { session: { get: vi.fn(), set: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
} as any;

// Polyfill OffscreenCanvas + createImageBitmap for the jsdom environment so
// CommandExecutor.captureScreenshot can downscale without real browser APIs.
// We deliberately keep this approximate — the goal is to exercise the wiring
// (capture → bitmap → canvas → convertToBlob → base64), not pixel accuracy.
class FakeImageBitmap {
  width: number; height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  close(): void { /* noop */ }
}

(globalThis as any).createImageBitmap = vi.fn(async (_blob: Blob) => new FakeImageBitmap(1920, 1080));

class FakeOffscreenCanvas {
  width: number; height: number;
  constructor(w: number, h: number) { this.width = w; this.height = h; }
  getContext(_kind: string): any {
    return { drawImage: vi.fn() };
  }
  async convertToBlob(_opts: { type: string; quality?: number }): Promise<any> {
    // Return an object that quacks like a Blob and exposes arrayBuffer().
    // jsdom's Blob lacks arrayBuffer in some versions; this stand-in keeps
    // the test deterministic across environments.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    return {
      type: "image/jpeg",
      size: bytes.length,
      async arrayBuffer(): Promise<ArrayBuffer> {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }
}

(globalThis as any).OffscreenCanvas = FakeOffscreenCanvas;

// Always override fetch so data: URLs work — jsdom's fetch doesn't support
// data: URLs natively, and we want a deterministic path here.
(globalThis as any).fetch = async (url: string) => {
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",");
    const meta = url.slice(5, comma);
    const isBase64 = meta.includes(";base64");
    const data = url.slice(comma + 1);
    const bytes = isBase64
      ? Uint8Array.from(atob(data), c => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(data));
    return {
      blob: async () => new Blob([bytes], { type: meta.split(";")[0] }),
    } as any;
  }
  throw new Error("fetch not implemented for " + url);
};

describe("CommandExecutor.captureScreenshot", () => {
  beforeEach(() => {
    captureVisibleTab.mockReset();
    tabsGet.mockReset();
    tabsGet.mockResolvedValue({ id: 1, windowId: 42 } as chrome.tabs.Tab);
  });

  it("returns null when captureVisibleTab returns no data URL", async () => {
    captureVisibleTab.mockResolvedValue("");
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.captureScreenshot(1);
    expect(result).toBeNull();
  });

  it("returns base64+meta when captureVisibleTab succeeds", async () => {
    // Tiny base64 payload (4 bytes encoded) is enough — the downscale path
    // routes through the FakeOffscreenCanvas above.
    captureVisibleTab.mockResolvedValue("data:image/jpeg;base64,/9j/2Q==");
    // Spy on console.error so a thrown error from inside captureScreenshot
    // surfaces as a test failure with a useful message instead of just `null`.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.captureScreenshot(1);
    if (!result) {
      const calls = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      throw new Error("captureScreenshot returned null. Console errors:\n" + calls);
    }
    expect(result.mime).toBe("image/jpeg");
    expect(result.b64.length).toBeGreaterThan(0);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.byte_size).toBeGreaterThan(0);
    errSpy.mockRestore();
  });

  it("downsamples when source exceeds the 1280px cap", async () => {
    // Stub createImageBitmap to report an oversized source — the
    // CommandExecutor should scale both dims so the longer side is <=1280.
    (globalThis as any).createImageBitmap = vi.fn(
      async () => new FakeImageBitmap(2560, 1440),
    );
    captureVisibleTab.mockResolvedValue("data:image/jpeg;base64,/9j/2Q==");
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.captureScreenshot(1);
    expect(result).not.toBeNull();
    if (!result) return;
    // Longest side at most 1280, aspect preserved (1280:720)
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1280);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
  });

  it("returns null on capture failure (does not throw)", async () => {
    captureVisibleTab.mockRejectedValue(new Error("permission denied"));
    const { CommandExecutor } = await import("../src/background/command-executor");
    const ce = new CommandExecutor();
    const result = await ce.captureScreenshot(1);
    expect(result).toBeNull();
  });
});
