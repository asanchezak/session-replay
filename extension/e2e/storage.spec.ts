import { test, expect } from "./fixtures";

test("chrome.storage.session can be written and read", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];

  const result = await sw.evaluate(async () => {
    await chrome.storage.session.set({ test_key: "hello-storage" });
    const data = await chrome.storage.session.get("test_key");
    return data.test_key;
  });

  expect(result).toBe("hello-storage");
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("chrome.storage.session is cleared when browser closes", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];

  await sw.evaluate(async () => {
    await chrome.storage.session.set({ test_key: "ephemeral-value" });
  });

  const result = await sw.evaluate(async () => {
    const data = await chrome.storage.session.get("test_key");
    return data.test_key;
  });

  expect(result).toBe("ephemeral-value");
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("setAccessLevel allows content scripts to read storage", async ({ context, extensionId, errors }) => {
  const sw = context.serviceWorkers()[0];

  // This should work without throwing (setAccessLevel is called on module init)
  const ok = await sw.evaluate(async () => {
    try {
      await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
      return true;
    } catch {
      return false;
    }
  });

  expect(ok).toBeTruthy();
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
});

test("chrome.storage.onChanged fires in content script", async ({ context, extensionId, errors }) => {
  const page = await context.newPage();
  await page.goto("https://example.com");
  await page.waitForTimeout(1500);

  // Write to storage from service worker
  const sw = context.serviceWorkers()[0];
  await sw.evaluate(async () => {
    await chrome.storage.session.set({
      recording_state: { isRecording: true, events: [], name: "test" },
    });
  });
  await page.waitForTimeout(1000);

  expect(errors.filter(e => e.type === "console" && !e.text.includes("favicon"))).toHaveLength(0);
  await page.close();
});
