// Verifies the shared, MINIMAL stealth bundle (src/shared/stealth.mjs).
//
// The bundle deliberately patches only what automation breaks
// (navigator.webdriver + permissions.query, masked via a toString proxy) and
// leaves WebGL / plugins / CPU / memory / locale to native Chrome so the
// fingerprint stays internally consistent for the real machine. This test
// asserts that consistency — in particular that we are NOT re-introducing the
// old "Intel Iris on an Apple-Silicon Mac" contradiction that got an account
// flagged.
//
// This test does NOT touch LinkedIn or any external service. It loads a
// `data:` URL so the fixture's addInitScript has a chance to run, then probes
// navigator/window state directly.

import { test, expect } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("minimal stealth: webdriver hidden, fingerprint internally consistent", async ({ context }) => {
  const page = await context.newPage();
  await page.goto("data:text/html,<title>stealth-probe</title>");

  const probe = await page.evaluate(async () => {
    const notifState = await navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((s) => s.state)
      .catch(() => "error");
    let webglRenderer = "n/a";
    let webglVendor = "n/a";
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl") as WebGLRenderingContext | null;
      if (gl) {
        // The unmasked renderer/vendor require the debug extension; without it
        // getParameter(37446) returns null (common in headless).
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        webglRenderer = String(gl.getParameter(ext ? (ext as { UNMASKED_RENDERER_WEBGL: number }).UNMASKED_RENDERER_WEBGL : 37446));
        webglVendor = String(gl.getParameter(ext ? (ext as { UNMASKED_VENDOR_WEBGL: number }).UNMASKED_VENDOR_WEBGL : 37445));
      }
    } catch { /* ignore */ }
    const uaData = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData;
    return {
      webdriver: (navigator as unknown as { webdriver?: unknown }).webdriver,
      languages: Array.from(navigator.languages),
      notifications_permission_state: notifState,
      webgl_renderer: webglRenderer,
      webgl_vendor: webglVendor,
      user_agent: navigator.userAgent,
      ua_data_platform: uaData?.platform ?? null,
      permissions_query_toString: navigator.permissions.query.toString(),
      function_prototype_toString_toString: Function.prototype.toString.toString(),
      // The native (unpatched) getParameter must still report native.
      webgl_getParameter_toString: WebGLRenderingContext.prototype.getParameter.toString(),
    };
  });

  // ---- The one thing automation breaks: webdriver must be hidden. ----------
  expect(probe.webdriver).toBeUndefined();

  // ---- Notifications normalized to "default" (not the automation "denied"). -
  expect(probe.notifications_permission_state).not.toBe("denied");

  // ---- Native, mutually-consistent identity (NOT spoofed). -----------------
  // Languages come from the real OS locale — non-empty, full-locale shape.
  expect(probe.languages.length).toBeGreaterThan(0);
  // Chrome on macOS (incl. Apple Silicon) always reports a "Macintosh" UA and a
  // "macOS" platform — this is correct and must be left native.
  expect(probe.user_agent).toMatch(/Macintosh/);
  if (probe.ua_data_platform) expect(probe.ua_data_platform).toBe("macOS");

  // ---- The core fix: NO Intel-on-Apple-Silicon WebGL lie. ------------------
  // We removed the override, so Chrome reports its true renderer. It must NOT
  // be the old hardcoded fake. Headed Chrome on M1 reports an Apple/Metal
  // renderer; headless can fall back to SwiftShader — both are legitimate,
  // internally-consistent native values, so we accept either but forbid the lie.
  expect(probe.webgl_renderer).not.toBe("Intel Iris OpenGL Engine");
  expect(probe.webgl_vendor).not.toBe("Intel Inc.");
  // Only assert the positive Apple-GPU shape when we actually have a real,
  // readable hardware renderer. Headless often can't expose the unmasked
  // renderer (null) or falls back to SwiftShader — both legitimate; the
  // production daemon runs headed where this resolves to Apple/Metal.
  const unreadable = ["null", "n/a", "", "undefined"].includes(probe.webgl_renderer);
  const isSoftware = /swiftshader|llvmpipe/i.test(probe.webgl_renderer);
  if (!unreadable && !isSoftware) {
    expect(probe.webgl_renderer).toMatch(/apple|metal/i);
  } else {
    console.log(`  (WebGL renderer not a readable HW value here: "${probe.webgl_renderer}" — skipping Apple-GPU positive check; ran headed to validate)`);
  }
  // getParameter must NOT be patched anymore — it is the genuine native fn.
  expect(probe.webgl_getParameter_toString).toMatch(/\bnative code\b/);

  // ---- toString integrity for the one function we DO patch. ----------------
  expect(probe.permissions_query_toString).toMatch(/\bnative code\b/);
  expect(probe.function_prototype_toString_toString).toMatch(/\bnative code\b/);

  await page.close();
});

test("stealth init script also runs on fresh tabs opened mid-session", async ({ context }) => {
  const a = await context.newPage();
  await a.goto("data:text/html,<title>a</title>");
  const wd_a = await a.evaluate(() => (navigator as unknown as { webdriver?: unknown }).webdriver);
  expect(wd_a).toBeUndefined();

  // Second page opened later (simulates noise navigations spawning a new tab).
  const b = await context.newPage();
  await b.goto("data:text/html,<title>b</title>");
  const wd_b = await b.evaluate(() => (navigator as unknown as { webdriver?: unknown }).webdriver);
  expect(wd_b).toBeUndefined();

  await a.close();
  await b.close();
});
