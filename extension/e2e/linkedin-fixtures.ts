import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const EXT_PATH = path.resolve(__dirname, "..");

// Persistent Chrome profile for the one-time login step
export const LINKEDIN_PROFILE_DIR = path.resolve(EXT_PATH, ".linkedin-profile");

// Where login cookies are exported for the recording step
export const LINKEDIN_STATE_PATH = path.resolve(EXT_PATH, ".linkedin-state.json");

export { EXT_PATH };

/** Opens a headed Chrome window with the given profile for manual login. */
export async function launchSetupContext() {
  return chromium.launchPersistentContext(LINKEDIN_PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--no-sandbox"],
  });
}
