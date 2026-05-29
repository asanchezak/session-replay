// Validates the daemon's wall-detection (src/behavior/blocker-detect.mjs)
// against local fixture pages — no LinkedIn, no network. Proves the daemon
// will PAUSE (not plow) when LinkedIn throws a login form / captcha / 2FA wall.

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
// @ts-expect-error — plain .mjs sibling module, no type decls needed for the test
import { detectChallengeInPage, isBlockerUrl } from "../src/behavior/blocker-detect.mjs";

let context: BrowserContext;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    headless: process.env.HEADLESS !== "false",
    channel: process.env.SR_E2E_CHANNEL || "chrome",
  });
});
test.afterAll(async () => { await context?.close(); });

const html = (body: string) => `data:text/html,${encodeURIComponent(`<!doctype html><title>t</title>${body}`)}`;

test("isBlockerUrl flags LinkedIn wall URLs and passes normal ones", () => {
  expect(isBlockerUrl("https://www.linkedin.com/checkpoint/challenge/abc")).toBe(true);
  expect(isBlockerUrl("https://www.linkedin.com/uas/login")).toBe(true);
  expect(isBlockerUrl("https://www.linkedin.com/authwall?trk=x")).toBe(true);
  expect(isBlockerUrl("https://www.linkedin.com/login?fromSignIn=true")).toBe(true);
  expect(isBlockerUrl("https://www.linkedin.com/in/john-doe/")).toBe(false);
  expect(isBlockerUrl("https://www.linkedin.com/search/results/people/?keywords=x")).toBe(false);
});

test("detectChallengeInPage finds a visible login form", async () => {
  const page = await context.newPage();
  await page.goto(html(`<form><input type="email" name="email"><input type="password" name="session_password"><button>Sign in</button></form>`));
  const r = await detectChallengeInPage(page);
  expect(r?.type).toBe("login_form");
  await page.close();
});

test("detectChallengeInPage finds a captcha iframe", async () => {
  const page = await context.newPage();
  await page.goto(html(`<iframe src="https://www.google.com/recaptcha/api2/anchor" style="width:300px;height:80px"></iframe>`));
  const r = await detectChallengeInPage(page);
  expect(r?.type).toBe("captcha");
  await page.close();
});

test("detectChallengeInPage finds a one-time-code (2FA) input", async () => {
  const page = await context.newPage();
  await page.goto(html(`<form><input autocomplete="one-time-code" name="pin"><button>Verify</button></form>`));
  const r = await detectChallengeInPage(page);
  expect(r?.type).toBe("two_factor");
  await page.close();
});

test("detectChallengeInPage ignores a promo-code field (false-positive guard)", async () => {
  const page = await context.newPage();
  await page.goto(html(`<form><input name="promo_code" inputmode="numeric"><button>Apply</button></form>`));
  const r = await detectChallengeInPage(page);
  expect(r).toBeNull();
  await page.close();
});

test("detectChallengeInPage returns null on a clean profile-like page", async () => {
  const page = await context.newPage();
  await page.goto(html(`<main><h2>Jane Doe</h2><p>Senior Engineer</p><a href="/in/jane/details/skills/">Show all skills</a></main>`));
  const r = await detectChallengeInPage(page);
  expect(r).toBeNull();
  await page.close();
});
