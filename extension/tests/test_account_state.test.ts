import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createAccountStateStore } from "../src/behavior/account-state.mjs";

// Fixed clock helper — Mon 2026-06-01 10:00 local.
function clockAt(iso: string) {
  let ms = new Date(iso).getTime();
  return {
    now: () => ms,
    advance: (deltaMs: number) => { ms += deltaMs; },
    set: (nextIso: string) => { ms = new Date(nextIso).getTime(); },
  };
}

describe("account-state budget + circuit breaker", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-state-"));
    file = path.join(dir, "budget.json");
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("daily profile-view budget exhausts then blocks", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const store = createAccountStateStore({
      file, accountId: "acct-a", now: clk.now,
      limits: { profileViewsPerDay: 3, profileViewsPerHour: 100, searchesPerDay: 100, pageLoadsPerDay: 1000 },
    });
    expect(store.budgetExhaustedReason()).toBeNull();
    store.recordProfileView();
    store.recordProfileView();
    expect(store.budgetExhaustedReason()).toBeNull();
    store.recordProfileView(); // 3rd → at limit
    expect(store.budgetExhaustedReason()).toBe("daily_profile_view_budget");
  });

  it("hourly budget resets in the next hour window", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const store = createAccountStateStore({
      file, accountId: "acct-a", now: clk.now,
      limits: { profileViewsPerDay: 1000, profileViewsPerHour: 2, searchesPerDay: 100, pageLoadsPerDay: 1000 },
    });
    store.recordProfileView();
    store.recordProfileView();
    expect(store.budgetExhaustedReason()).toBe("hourly_profile_view_budget");
    clk.advance(3600_000); // next hour
    expect(store.budgetExhaustedReason()).toBeNull();
  });

  it("persists across store instances (survives daemon restart)", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const opts = {
      file, accountId: "acct-a", now: clk.now,
      limits: { profileViewsPerDay: 2, profileViewsPerHour: 100, searchesPerDay: 100, pageLoadsPerDay: 1000 },
    };
    const s1 = createAccountStateStore(opts);
    s1.recordProfileView();
    s1.recordProfileView();
    const s2 = createAccountStateStore(opts); // fresh instance, same file
    expect(s2.budgetExhaustedReason()).toBe("daily_profile_view_budget");
  });

  it("a fresh account id ignores another account's sidecar", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const a = createAccountStateStore({ file, accountId: "acct-a", now: clk.now, limits: { profileViewsPerDay: 1, profileViewsPerHour: 100, searchesPerDay: 100, pageLoadsPerDay: 1000 } });
    a.recordProfileView();
    expect(a.budgetExhaustedReason()).toBe("daily_profile_view_budget");
    const b = createAccountStateStore({ file, accountId: "acct-b", now: clk.now, limits: { profileViewsPerDay: 1, profileViewsPerHour: 100, searchesPerDay: 100, pageLoadsPerDay: 1000 } });
    expect(b.budgetExhaustedReason()).toBeNull();
  });

  it("circuit breaker escalates 4h→12h→24h and opens/closes on the clock", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const store = createAccountStateStore({ file, accountId: "acct-a", now: clk.now });
    expect(store.circuitOpen()).toBe(false);

    const t1 = store.tripCircuit("login_form");
    expect(t1.cooldown_ms).toBe(4 * 3600_000);
    expect(store.circuitOpen()).toBe(true);

    clk.advance(4 * 3600_000 + 1000); // past first cooldown
    expect(store.circuitOpen()).toBe(false);

    const t2 = store.tripCircuit("login_form");
    expect(t2.cooldown_ms).toBe(12 * 3600_000);
    const t3 = store.tripCircuit("captcha");
    expect(t3.cooldown_ms).toBe(24 * 3600_000);
  });

  it("soft signals use the soft ladder (1h, 4h)", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const store = createAccountStateStore({ file, accountId: "acct-a", now: clk.now });
    const s1 = store.tripCircuit("soft_empty", true);
    expect(s1.cooldown_ms).toBe(1 * 3600_000);
    const s2 = store.tripCircuit("soft_empty", true);
    expect(s2.cooldown_ms).toBe(4 * 3600_000);
  });

  it("consecutive trips reset after a quiet period", () => {
    const clk = clockAt("2026-06-01T10:00:00");
    const store = createAccountStateStore({ file, accountId: "acct-a", now: clk.now });
    store.tripCircuit("login_form"); // trip 1
    clk.advance(25 * 3600_000); // > 24h quiet
    const again = store.tripCircuit("login_form");
    expect(again.consecutive_trips).toBe(1); // reset, back to first rung
    expect(again.cooldown_ms).toBe(4 * 3600_000);
  });

  it("isWithinWorkingHours respects hours + days", () => {
    // 2026-06-01 is a Monday.
    const store = createAccountStateStore({
      file, accountId: "acct-a",
      now: () => new Date("2026-06-01T10:00:00").getTime(),
      work: { startHour: 8, endHour: 19, days: [1, 2, 3, 4, 5], enabled: true },
    });
    expect(store.isWithinWorkingHours()).toBe(true);
    expect(store.isWithinWorkingHours(new Date("2026-06-01T07:00:00").getTime())).toBe(false); // before hours
    expect(store.isWithinWorkingHours(new Date("2026-06-01T20:00:00").getTime())).toBe(false); // after hours
    expect(store.isWithinWorkingHours(new Date("2026-06-06T10:00:00").getTime())).toBe(false); // Saturday
  });
});
