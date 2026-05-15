/**
 * Tests for api.ts getConfig() and DEV_DEFAULTS.
 *
 * Pins:
 * - getConfig() returns DEV_DEFAULTS when chrome.storage.session is empty
 * - getConfig() returns stored values when present
 * - DEV_DEFAULTS.apiKey is not the old insecure default
 * - DEV_DEFAULTS.apiBase has the correct URL format
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const storage: Record<string, unknown> = {};

const chromeMock = {
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
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
      setAccessLevel: vi.fn(),
    },
  },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
};

vi.stubGlobal("chrome", chromeMock);

describe("DEV_DEFAULTS", () => {
  it("has the expected shape", async () => {
    const { DEV_DEFAULTS } = await import("../src/background/api");
    expect(DEV_DEFAULTS).toHaveProperty("apiBase");
    expect(DEV_DEFAULTS).toHaveProperty("apiKey");
    expect(DEV_DEFAULTS).toHaveProperty("aiApiKey");
  });

  it("apiBase is a valid URL", async () => {
    const { DEV_DEFAULTS } = await import("../src/background/api");
    expect(() => new URL(DEV_DEFAULTS.apiBase)).not.toThrow();
    expect(DEV_DEFAULTS.apiBase).toMatch(/^https?:\/\//);
  });

  it("apiKey is not the old insecure default", async () => {
    const { DEV_DEFAULTS } = await import("../src/background/api");
    expect(DEV_DEFAULTS.apiKey).not.toBe("dev-api-key-change-in-production");
    expect(DEV_DEFAULTS.apiKey.length).toBeGreaterThan(16);
  });
});

describe("getConfig", () => {
  beforeEach(() => {
    for (const k of Object.keys(storage)) delete storage[k];
    vi.clearAllMocks();
  });

  it("returns DEV_DEFAULTS when storage is empty", async () => {
    const { getConfig, DEV_DEFAULTS } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.apiBase).toBe(DEV_DEFAULTS.apiBase);
    expect(config.apiKey).toBe(DEV_DEFAULTS.apiKey);
    expect(config.aiApiKey).toBe(DEV_DEFAULTS.aiApiKey);
  });

  it("returns stored apiKey when set", async () => {
    storage["apiKey"] = "stored-key-value";
    const { getConfig } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.apiKey).toBe("stored-key-value");
  });

  it("returns stored apiBase when set", async () => {
    storage["apiBaseUrl"] = "https://example.com/api";
    const { getConfig } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.apiBase).toBe("https://example.com/api");
  });

  it("returns stored aiApiKey when set", async () => {
    storage["aiApiKey"] = "sk-stored-key";
    const { getConfig } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.aiApiKey).toBe("sk-stored-key");
  });

  it("falls back to DEV_DEFAULTS when only some keys are stored", async () => {
    storage["apiKey"] = "custom-key";
    const { getConfig, DEV_DEFAULTS } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.apiKey).toBe("custom-key");
    expect(config.apiBase).toBe(DEV_DEFAULTS.apiBase);
    expect(config.aiApiKey).toBe(DEV_DEFAULTS.aiApiKey);
  });

  it("returns DEV_DEFAULTS when chrome.storage.session.get throws", async () => {
    chromeMock.storage.session.get = vi.fn().mockRejectedValueOnce(new Error("storage unavailable"));
    const { getConfig, DEV_DEFAULTS } = await import("../src/background/api");
    const config = await getConfig();
    expect(config.apiBase).toBe(DEV_DEFAULTS.apiBase);
    expect(config.apiKey).toBe(DEV_DEFAULTS.apiKey);
  });
});
