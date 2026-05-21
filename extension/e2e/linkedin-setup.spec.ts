/**
 * One-time setup: log in to LinkedIn in a headed Chrome window.
 * Saves session cookies to .linkedin-state.json for use by linkedin-record.
 *
 * Run once with:
 *   cd extension && npx playwright test e2e/linkedin-setup.spec.ts --headed
 */
import { test, expect } from "@playwright/test";
import { launchSetupContext, LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

test.describe.configure({ mode: "serial" });

// Use a custom context — bypass the default fixture so we can use Chrome + persistent profile
test.use({ browserName: "chromium" });

test("log in to LinkedIn and save session cookies", async () => {
  const context = await launchSetupContext();

  try {
    const page = await context.newPage();
    await page.goto("https://www.linkedin.com/login");

    console.log("\nPlease log in to LinkedIn in the browser window.");
    console.log("Waiting up to 3 minutes for you to complete login...\n");

    await page.waitForURL(/linkedin\.com\/(feed|mynetwork|messaging|jobs)/, {
      timeout: 180_000,
    });

    console.log("Login detected. Saving session cookies...");
    await page.waitForTimeout(2000);

    await context.storageState({ path: LINKEDIN_STATE_PATH });
    console.log(`Session saved to: ${LINKEDIN_STATE_PATH}`);
    console.log("You can now run: npx playwright test e2e/linkedin-record.spec.ts --headed");

    expect(page.url()).toMatch(/linkedin\.com/);
  } finally {
    await context.close();
  }
});
