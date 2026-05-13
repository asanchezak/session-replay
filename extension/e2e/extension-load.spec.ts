import { test, expect } from "./fixtures";

test("service worker loads and reports extension installed", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];
  expect(sw).toBeDefined();
  expect(sw.url()).toContain(extensionId);

  // Verify SW URL structure
  const url = new URL(sw.url());
  expect(url.protocol).toBe("chrome-extension:");
  expect(url.hostname).toBe(extensionId);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("manifest declares required permissions", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];

  const permissions = await sw.evaluate(async () => {
    // We can't read manifest directly from SW, but we can test that key APIs exist
    const apis = {
      storage: typeof chrome.storage !== "undefined",
      storageSession: typeof chrome.storage?.session !== "undefined",
      tabs: typeof chrome.tabs !== "undefined",
      runtime: typeof chrome.runtime !== "undefined",
      scripting: typeof chrome.scripting !== "undefined",
    };
    return apis;
  });

  expect(permissions.storage).toBeTruthy();
  expect(permissions.storageSession).toBeTruthy();
  expect(permissions.tabs).toBeTruthy();
  expect(permissions.runtime).toBeTruthy();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("extension icons are accessible", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];

  const iconsExist = await sw.evaluate(async () => {
    const urls = [
      chrome.runtime.getURL("icons/icon-16.png"),
      chrome.runtime.getURL("icons/icon-48.png"),
      chrome.runtime.getURL("icons/icon-128.png"),
    ];
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const resp = await fetch(url);
          return { url, ok: resp.ok, size: (await resp.blob()).size };
        } catch {
          return { url, ok: false, size: 0 };
        }
      }),
    );
    return results;
  });

  for (const icon of iconsExist) {
    expect(icon.ok).toBeTruthy();
    expect(icon.size).toBeGreaterThan(100);
  }

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("popup HTML is served", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  const resp = await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  expect(resp?.ok()).toBeTruthy();
  expect(await page.title()).toContain("Session Replay");
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});

test("panel HTML is served", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  const resp = await page.goto(`chrome-extension://${extensionId}/dist/panel.html`);
  expect(resp?.ok()).toBeTruthy();

  const bodyText = await page.evaluate(() => document.body?.innerText || "");
  expect(bodyText).toBeTruthy();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
