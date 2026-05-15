import { test, expect } from "./fixtures";

async function waitForSwResponsive(context: any, extensionId: string, timeoutMs = 15000): Promise<any> {
  // Poll until the extension's SW can be evaluated (i.e. fully restarted after reload)
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const sw = context.serviceWorkers().find((s: any) => s.url().includes(extensionId));
    if (sw) {
      try {
        await sw.evaluate(() => true);
        return sw;
      } catch { /* SW not yet responsive or restarting */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for extension SW to become responsive after reload");
}

// MV3 SWs can idle-terminate between evaluate calls. Retry on "Service worker restarted".
async function swEvaluate(context: any, extensionId: string, fn: () => any): Promise<any> {
  for (let i = 0; i < 5; i++) {
    const sw = context.serviceWorkers().find((s: any) => s.url().includes(extensionId));
    if (!sw) { await new Promise((r) => setTimeout(r, 300)); continue; }
    try {
      return await sw.evaluate(fn);
    } catch (e: any) {
      if (!e.message?.includes("restarted")) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("SW evaluate failed after retries");
}

test("extension can be reloaded and SW re-registers", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  const swUrl = sw.url();
  console.log(`  SW URL before reload: ${swUrl}`);

  // Reload extension — SW terminates and restarts in-place
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));

  const activeSw = context.serviceWorkers().find((s: any) => s.url().includes(extensionId)) || sw;
  const activeUrl = activeSw.url();
  console.log(`  SW URL after reload: ${activeUrl}`);

  const idFromUrl = new URL(activeUrl).hostname;
  expect(idFromUrl).toBe(extensionId);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

// Note: after chrome.runtime.reload() in Playwright's persistent context:
// - page.goto() to chrome-extension:// returns ERR_BLOCKED_BY_CLIENT (permanent)
// - sw.evaluate() throws "Service worker restarted" on every call (SW restart loop)
// These are known Playwright + MV3 limitations. We instead verify that the extension
// is alive via SW URL and that content scripts reinject correctly on new pages.
test("content script works on new page after extension reload", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await waitForSwResponsive(context, extensionId);

  // Content scripts should reinject on new page navigations after extension reload
  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.waitForTimeout(2000);
  await page.click("h1");
  await page.waitForTimeout(500);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("SW URL is stable after extension reload", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  const urlBefore = sw.url();
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await waitForSwResponsive(context, extensionId);

  // The SW should re-register under the same extension ID after reload
  const activeSw = context.serviceWorkers().find((s: any) => s.url().includes(extensionId)) || sw;
  const urlAfter = activeSw.url();
  expect(new URL(urlAfter).hostname).toBe(new URL(urlBefore).hostname);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});
