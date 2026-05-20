/**
 * Workstream A (run_script) E2E: invoke CommandExecutor.runScript via the
 * service worker and verify the harness runs an AI-supplied function body
 * in the page's MAIN world, returning the value with logs and duration.
 *
 * No backend AI call: we exercise the SW path directly via the
 * __SR_commandExecutor test bridge so the test is fast and deterministic.
 * The fixture is served from http://sr-test.local so the extension's
 * host permissions allow chrome.scripting.executeScript.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const TEST_PAGE_URL = "http://sr-test.local/run-script-target";
const TARGET_HTML = `<!DOCTYPE html>
<html><head><title>run_script E2E</title></head>
<body>
  <h1>Run Script Target</h1>
  <div id="data" data-payload="42">payload</div>
  <script>
    window.__counter__ = 42;
    window.__app__ = { version: "1.2.3" };
  </script>
</body></html>`;

interface ScriptCallArgs {
  pattern: string;
  source: string;
  scriptTimeoutMs: number;
}

interface ScriptResult {
  __skip?: string;
  __error?: string;
  success?: boolean;
  error?: string;
  script_result?: unknown;
  script_logs?: string[];
  script_duration_ms?: number;
}

async function serveFixture(page: Page) {
  await page.route("**/sr-test.local/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: TARGET_HTML,
    });
  });
}

async function callRunScript(
  context: BrowserContext, args: ScriptCallArgs,
): Promise<ScriptResult> {
  const sw = context.serviceWorkers()[0]
    ?? await context.waitForEvent("serviceworker", { timeout: 10_000 });
  return await sw.evaluate(async (a: ScriptCallArgs): Promise<ScriptResult> => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((t) => (t.url ?? "").includes(a.pattern));
    if (!target?.id) return { __error: `no tab matching ${a.pattern}` };
    const ce = (self as any).__SR_commandExecutor;
    if (!ce || typeof ce.runScript !== "function") {
      return { __skip: "__SR_commandExecutor not exposed on SW global" };
    }
    return await ce.runScript(target.id, {
      action: "run_script",
      target: null, value: null, selector_chain: [], intent: "e2e",
      methods: [], timeout_ms: 5000, success_condition: null,
      script: a.source,
      script_args: {},
      script_timeout_ms: a.scriptTimeoutMs,
    });
  }, args);
}

test("run_script: returns page-global value via the SW CommandExecutor bridge", async ({ context }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await serveFixture(page);
  await page.goto(TEST_PAGE_URL);
  await expect(page.locator("h1")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__counter__)).toBe(42);

  const result = await callRunScript(context, {
    pattern: "sr-test.local/run-script-target",
    source: "return { counter: window.__counter__, version: window.__app__.version };",
    scriptTimeoutMs: 5000,
  });

  if (result.__skip) {
    test.skip(true, result.__skip);
    return;
  }
  if (result.__error) throw new Error(result.__error);
  expect(result.success).toBe(true);
  expect(result.script_result).toEqual({ counter: 42, version: "1.2.3" });
  expect(typeof result.script_duration_ms).toBe("number");
  await page.close();
});

test("run_script: SCRIPT_TIMEOUT when the script exceeds its budget", async ({ context }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await serveFixture(page);
  await page.goto(TEST_PAGE_URL);
  await expect(page.locator("h1")).toBeVisible();

  const result = await callRunScript(context, {
    pattern: "sr-test.local/run-script-target",
    source: "await new Promise(r => setTimeout(r, 10000)); return 'late';",
    scriptTimeoutMs: 200,
  });

  if (result.__skip) {
    test.skip(true, result.__skip);
    return;
  }
  expect(result.success).toBe(false);
  expect(result.error).toBe("SCRIPT_TIMEOUT");
  await page.close();
});

test("run_script: SCRIPT_THREW surfaces uncaught errors without crashing", async ({ context }) => {
  test.setTimeout(60_000);
  const page = await context.newPage();
  await serveFixture(page);
  await page.goto(TEST_PAGE_URL);
  await expect(page.locator("h1")).toBeVisible();

  const result = await callRunScript(context, {
    pattern: "sr-test.local/run-script-target",
    source: "throw new Error('boom');",
    scriptTimeoutMs: 5000,
  });

  if (result.__skip) {
    test.skip(true, result.__skip);
    return;
  }
  expect(result.success).toBe(false);
  expect(String(result.error)).toContain("SCRIPT_THREW");
  expect(String(result.error)).toContain("boom");
  await page.close();
});
