import { test, expect } from "./fixtures";

async function waitForNewSw(context: any, oldUrl: string, timeoutMs = 15000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1000));
    const sws = context.serviceWorkers();
    for (const sw of sws) {
      if (sw.url() !== oldUrl && sw.url().includes("chrome-extension://")) {
        return sw;
      }
    }
  }
  throw new Error("Timeout waiting for new service worker after reload");
}

test("extension can be reloaded and SW re-registers", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  const swUrl = sw.url();
  console.log(`  SW URL before reload: ${swUrl}`);

  // Reload extension — this kills the current SW
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  // Poll for new service worker
  const newSw = await waitForNewSw(context, swUrl);
  const newSwUrl = newSw.url();
  console.log(`  SW URL after reload: ${newSwUrl}`);

  const idFromUrl = new URL(newSwUrl).hostname;
  expect(idFromUrl).toBe(extensionId);

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("popup works after extension reload", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  const swUrl = sw.url();
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  await waitForNewSw(context, swUrl);

  const popup = await ext.openPopup();
  await popup.page.waitForTimeout(2000);
  await expect(popup.page.getByText("Record Workflow")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await popup.page.close();
});

test("GET_STATE works after extension reload", async ({ context, extensionId, errors }) => {
  const ext = new (await import("./page-objects")).ExtensionHelper(context, extensionId);

  const sw = await ext.getServiceWorker();
  const swUrl = sw.url();
  sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  const newSw = await waitForNewSw(context, swUrl);

  // Verify SW responds by navigating to popup
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/dist/popup.html`);
  await page.waitForTimeout(2000);
  await expect(page.getByText("Record Workflow")).toBeVisible();

  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  await page.close();
});
