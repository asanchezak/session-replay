/**
 * One-time INTERACTIVE sign-in to LinkedIn Talent Solutions (Recruiter) into the
 * staged .linkedin-profile. Recruiter is a separate product from linkedin.com:
 * the daemon's regular session does NOT carry a Recruiter seat session, so a
 * human must sign in once. After this, the Recruiter cookies live in
 * .linkedin-profile and the S4U daemon/probe context can use /talent/.
 *
 * IMPORTANT: run this AS THE `linkedin-bot` USER (the daemon's DPAPI context).
 * If launched as a different Windows user, the cookies get encrypted under the
 * wrong DPAPI key and the daemon can't read them (and may corrupt the profile).
 *
 * Opens a visible Chrome window; the operator signs in (email is pre-filled),
 * enters the password, and solves any challenge. Auto-closes once a real
 * Recruiter page loads (URL on /talent/ and off any login wall).
 */
import { chromium } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { STEALTH_INIT } from "./src/shared/stealth.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROFILE_DIR = path.resolve(__dirname, ".linkedin-profile");

// HARD GUARD: cookies in .linkedin-profile are DPAPI-encrypted under the Windows
// user that writes them. The daemon reads them as `linkedin-bot`. If this runs as
// any other user (e.g. Fernanda's personal account), the saved Recruiter session
// is unreadable by the daemon — a silent failure. Refuse to proceed.
const WIN_USER = (process.env.USERNAME || "").toLowerCase();
if (process.platform === "win32" && WIN_USER && WIN_USER !== "linkedin-bot") {
  console.error("\n" + "!".repeat(70));
  console.error(`ABORT: running as Windows user "${process.env.USERNAME}", not "linkedin-bot".`);
  console.error("The daemon reads .linkedin-profile as linkedin-bot (DPAPI). Cookies saved");
  console.error("under another user are unreadable by the daemon. Re-run as linkedin-bot.");
  console.error("!".repeat(70) + "\n");
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI",
    "--profile-directory=Default",
  ],
  ignoreDefaultArgs: ["--enable-automation"],
});
await ctx.addInitScript(STEALTH_INIT);

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto("https://www.linkedin.com/talent/");

console.log("");
console.log("=".repeat(70));
console.log("Sign in to LinkedIn Talent Solutions (Recruiter) in the Chrome window.");
console.log("The email should be pre-filled — enter the password, solve any");
console.log("challenge. If a CONTRACT picker appears, choose 'Morsoft SRL - Recruiter'.");
console.log("Watching until a real /talent/ page loads (max 25 min)...");
console.log("=".repeat(70));

// "Done" = on a real /talent/ page, NOT on a login wall AND NOT still sitting on the
// contract chooser. The seat has multiple contracts; if we closed on the chooser the
// captured session would have no contract selected and the recruiter surfaces (projects/
// search) would wall. So wait until the operator picks the Morsoft Recruiter contract and
// lands on an actual recruiter page.
const onTalent = (u) =>
  /linkedin\.com\/talent\//.test(u) &&
  !/\/uas\/login|login-cap|\/checkpoint\/|\/login\b|authwall|\/challenge|\/contract-chooser/i.test(u);

const deadline = Date.now() + 25 * 60_000;
let last = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = page.url();
  if (cur !== last) { console.log("  url ->", cur); last = cur; }
  if (onTalent(cur)) {
    console.log("Recruiter session established. URL:", cur);
    await new Promise((r) => setTimeout(r, 5000)); // let cookies flush to disk
    break;
  }
}
const final = page.url();
console.log(onTalent(final) ? "OK — Recruiter signed in. You can close this." : `NOT signed in. Final URL: ${final}`);
await new Promise((r) => setTimeout(r, 2500));
await ctx.close();
process.exit(0);
