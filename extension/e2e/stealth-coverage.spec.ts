// Verifies the Proxy-based stealth bundle in fixtures.ts masks every
// fingerprint vector LinkedIn's anti-bot is known to probe.
//
// This test does NOT touch LinkedIn or any external service. It loads a
// `data:` URL so the fixture's addInitScript has a chance to run, then
// probes navigator/window state directly.

import { test, expect } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("Proxy-based stealth masks every fingerprint surface", async ({ context }) => {
  const page = await context.newPage();
  // A data URL is enough to trigger document creation and run the
  // addInitScript. We don't need real network.
  await page.goto("data:text/html,<title>stealth-probe</title>");

  const probe = await page.evaluate(async () => {
    const w = window as unknown as { chrome?: { runtime?: unknown } };
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
        webglRenderer = String(gl.getParameter(37446));
        webglVendor = String(gl.getParameter(37445));
      }
    } catch { /* ignore */ }
    return {
      webdriver: (navigator as unknown as { webdriver?: unknown }).webdriver,
      plugins_length: navigator.plugins.length,
      plugins_first_name: navigator.plugins[0]?.name ?? null,
      mime_types_length: navigator.mimeTypes.length,
      languages: Array.from(navigator.languages),
      notifications_permission_state: notifState,
      chrome_runtime_type: typeof w.chrome?.runtime,
      webgl_renderer: webglRenderer,
      webgl_vendor: webglVendor,
      notification_permission:
        typeof Notification !== "undefined" ? Notification.permission : "no-notification",
      hardware_concurrency: navigator.hardwareConcurrency,
      device_memory: (navigator as unknown as { deviceMemory?: number }).deviceMemory,
      permissions_query_toString: navigator.permissions.query.toString(),
      webgl_getParameter_toString:
        WebGLRenderingContext.prototype.getParameter.toString(),
      function_prototype_toString_toString:
        Function.prototype.toString.toString(),
    };
  });

  // Core webdriver flag is hidden.
  expect(probe.webdriver).toBeUndefined();

  // Plugin list is shaped like real Chrome — at least the 5 PDF entries.
  expect(probe.plugins_length).toBeGreaterThanOrEqual(5);
  expect(probe.plugins_first_name).toBeTruthy();
  expect(probe.mime_types_length).toBeGreaterThanOrEqual(1);

  // Languages reported with full locale + base.
  expect(probe.languages).toEqual(expect.arrayContaining(["en-US", "en"]));

  // Notifications permission is "default" (real Chrome) not "denied" (headless).
  expect(probe.notifications_permission_state).not.toBe("denied");

  // window.chrome.runtime exists.
  expect(probe.chrome_runtime_type).toBe("object");

  // WebGL renderer/vendor are NOT the SwiftShader software fallback that
  // headless Chrome reports.
  expect(probe.webgl_renderer).not.toMatch(/swiftshader/i);
  expect(probe.webgl_vendor).not.toMatch(/google/i);

  // Notification.permission surfaces as "default" not "denied".
  expect(probe.notification_permission).not.toBe("denied");

  // Hardware/memory shapes look realistic.
  expect(probe.hardware_concurrency).toBeGreaterThanOrEqual(4);
  expect(probe.device_memory).toBeGreaterThanOrEqual(4);

  // The critical toString test: a real Chrome's native fn returns
  // `function name() { [native code] }`. Our masked functions must do
  // the same so detectors checking .toString() see no patches.
  expect(probe.permissions_query_toString).toMatch(/\bnative code\b/);
  expect(probe.webgl_getParameter_toString).toMatch(/\bnative code\b/);
  // The Function.prototype.toString proxy itself must also pretend to be native.
  expect(probe.function_prototype_toString_toString).toMatch(/\bnative code\b/);

  await page.close();
});

test("stealth init script also runs on fresh tabs opened mid-session", async ({ context }) => {
  // First page sets a baseline.
  const a = await context.newPage();
  await a.goto("data:text/html,<title>a</title>");
  const wd_a = await a.evaluate(() => (navigator as unknown as { webdriver?: unknown }).webdriver);
  expect(wd_a).toBeUndefined();

  // Second page opened later (simulates noise navigations spawning a new tab).
  const b = await context.newPage();
  await b.goto("data:text/html,<title>b</title>");
  const wd_b = await b.evaluate(() => (navigator as unknown as { webdriver?: unknown }).webdriver);
  expect(wd_b).toBeUndefined();
  const renderer_b = await b.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    return gl ? String(gl.getParameter(37446)) : "no-webgl";
  });
  expect(renderer_b).not.toMatch(/swiftshader/i);

  await a.close();
  await b.close();
});
