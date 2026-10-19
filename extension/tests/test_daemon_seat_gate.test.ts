// Part B: the daemon seat-warmth gate in pickPendingRun. Seat-requiring runs must
// be HELD (not claimed) until keepAliveTick confirms the /talent seat is warm;
// generic (non-seat) runs are always claimable; and once the seat is warm the held
// runs drain. Module-level seatWarm/keepaliveObserved are driven via keepAliveTick.
import { describe, it, expect, beforeEach } from "vitest";

// The hot behavior module is plain ESM (.mjs) — import it directly.
// @ts-expect-error — no type decls for the runtime strategy module
import * as behavior from "../runtime-strategies/daemon-behavior.mjs";

const OPERATOR = "fernanda";
const api = { config: { OPERATOR_ID: OPERATOR } } as any;

function seatRun(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    status: "queued",
    current_step_index: 0,
    created_at: "2026-07-07T10:00:00Z",
    origin: {
      event_kind: "recruiter_recommendations",
      execution_target: "daemon",
      target_operator: OPERATOR,
      ...extra,
    },
  };
}

function genericRun(id: string) {
  return {
    id,
    status: "queued",
    current_step_index: 0,
    created_at: "2026-07-07T10:00:00Z",
    origin: {
      event_kind: "generic_click",
      execution_target: "daemon",
      execution_mode: "generic",
      target_operator: OPERATOR,
    },
  };
}

// Minimal keepAliveTick harness: it navigates a page; we stub just enough of the
// api bag for it to reach the walled/warm verdict and set module-level seatWarm.
function makeKeepAliveApi(walled: boolean) {
  const page = {
    goto: async () => {},
    waitForLoadState: async () => {},
    url: () => (walled ? "https://www.linkedin.com/uas/login-cap" : "https://www.linkedin.com/talent/home"),
    title: async () => "",
    isClosed: () => false,
  };
  return {
    helpers: {
      sleep: async () => {},
      isBlockerUrl: (u: string) => /login|checkpoint/i.test(u),
      assertNoBlocker: async () => {},
      moveMouseAlongBezier: async () => {},
      humanScrollSeeded: async () => {},
    },
    io: { fetchJson: async () => ({}) },
    config: {
      BACKEND: "http://x",
      RECRUITER_PING_MIN_MS: 1000,
      RECRUITER_PING_MAX_MS: 2000,
      RECRUITER_PING_WALLED_BACKOFF_MS: 3000,
    },
    state: {
      getProfileContext: async () => ({ pages: () => [page], newPage: async () => page, cookies: async () => [] }),
      getWarmPage: () => page,
      setWarmPage: () => {},
    },
  } as any;
}

describe("daemon seat gate (pickPendingRun)", () => {
  beforeEach(async () => {
    // Reset the gate to "walled" before each test via a keepalive tick.
    await behavior.keepAliveTick(makeKeepAliveApi(true));
  });

  it("holds seat-requiring runs while the seat is walled", () => {
    const picked = behavior.pickPendingRun([seatRun("s1")], api);
    expect(picked).toBeNull();
  });

  it("still claims generic (non-seat) runs while the seat is walled", () => {
    const picked = behavior.pickPendingRun([genericRun("g1"), seatRun("s1")], api);
    expect(picked?.id).toBe("g1");
  });

  it("drains held seat runs once the seat is warm", async () => {
    await behavior.keepAliveTick(makeKeepAliveApi(false)); // seat now warm
    const picked = behavior.pickPendingRun([seatRun("s1")], api);
    expect(picked?.id).toBe("s1");
  });
});

// A run that lands on LinkedIn's login wall fails at its first click/type (instead of
// typing into the login form) and closes the gate, even though the last keepalive said warm.
describe("daemon login wall in a generic step (driveGenericStep)", () => {
  function stepApi() {
    return {
      helpers: {
        isBlockerUrl: (u: string) => /\/checkpoint\/|\/uas\/login|\/login\?|\/login$|authwall|\/challenge/i.test(u),
        resolveLocatorWithWait: async () => null,
        resolveLocator: async () => null,
      },
      config: { STEP_RESOLVE_TIMEOUT_MS: 10 },
    } as any;
  }
  const drive = (url: string) =>
    behavior.driveGenericStep({
      step: { selector_chain: [{ type: "css", value: "#name" }] },
      page: { url: () => url },
      idx: 4,
      action: "type",
      value: "x",
      orand: Math.random,
      api: stepApi(),
    });

  beforeEach(async () => {
    await behavior.keepAliveTick(makeKeepAliveApi(false)); // last keepalive: warm
  });

  it("fails on the Recruiter login wall with the walled reason and holds seat runs", async () => {
    const res = await drive(
      "https://www.linkedin.com/uas/login-cap?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Ftalent%2Fcreate%2Fget-started",
    );
    expect(res.critFail).toMatch(/Recruiter seat walled/);
    expect(behavior.pickPendingRun([seatRun("s1")], api)).toBeNull();
  });

  it("leaves another site's login page alone", async () => {
    const res = await drive("https://app.example.com/login");
    expect(res.critFail).toBeNull();
    expect(behavior.pickPendingRun([seatRun("s1")], api)?.id).toBe("s1");
  });

  it("acts normally on a warm /talent page", async () => {
    const res = await drive("https://www.linkedin.com/talent/create/get-started");
    expect(res.critFail).toBeNull();
    expect(behavior.pickPendingRun([seatRun("s1")], api)?.id).toBe("s1");
  });
});
