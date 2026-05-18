import { describe, it, expect, vi, beforeEach } from "vitest";

const storage: Record<string, unknown> = {};

const chromeMock = {
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
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
  tabs: { query: vi.fn(), sendMessage: vi.fn() },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
};

vi.stubGlobal("chrome", chromeMock);

describe("ApiClient extraction contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storage)) delete storage[key];
    storage.apiBaseUrl = "http://localhost:8081/v1";
    storage.apiKey = "test-key";
  });

  it("sends output_schema in extraction payload", async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "recorded", records: 1 }),
    }));
    vi.stubGlobal("fetch", fetchSpy);

    const { apiClient } = await import("../src/background/api");
    await apiClient.reportExtraction("run-1", 3, [{ title: "Engineer" }], { type: "array" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.output_schema).toEqual({ type: "array" });
    expect(body).not.toHaveProperty("schema");
  });
});
