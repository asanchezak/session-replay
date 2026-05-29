/**
 * Smoke test: can the daemon run HEADED Chrome inside a macOS user session that
 * is NOT the foreground (Fast User Switching / Screen-Sharing virtual display)?
 *
 * This is THE crux of the "canonical host = Fernanda's one Mac, bot in a
 * dedicated `linkedin-bot` user" model (see plan: Host canónico). If headed
 * Chrome keeps rendering + navigating while the human user is switched in front,
 * the model works. If it freezes/crashes, fall back to headless or a dedicated
 * Mac.
 *
 * HOW TO RUN (on the Mac that will host the bot):
 *   1. Create a dedicated user, e.g.:
 *        sudo sysadminctl -addUser linkedin-bot -fullName "LinkedIn Bot" -password -
 *   2. System Settings → General → Sharing → enable "Screen Sharing".
 *   3. From another machine (or this one), open Screen Sharing.app and connect,
 *      logging in AS linkedin-bot — this creates a virtual GUI session for it.
 *   4. In that session's terminal:  cd <repo>/extension && node test-bg-session-chrome.mjs
 *   5. While it loops, SWITCH the physical screen to your normal user
 *      (Fast User Switching). The script should keep printing OK every few
 *      seconds — that proves headed Chrome survives being backgrounded.
 *
 * Needs: playwright + a Chrome channel. Uses an isolated temp profile (NOT the
 * whitelisted LinkedIn profile) and only hits example.com — zero LinkedIn risk.
 */
import { chromium } from "playwright";
import os from "os";
import path from "path";
import fs from "fs";

const ITERATIONS = Number(process.env.ITERATIONS || "10");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || "3000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-session-chrome-"));

console.log(`[smoke] launching HEADED Chrome (temp profile ${profileDir})`);
console.log(`[smoke] switch your physical screen to another user now; this must keep printing OK\n`);

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

let ok = 0;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (let i = 1; i <= ITERATIONS; i++) {
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    // Render a frame + read it back: this is what actually breaks in a dead
    // window-server session.
    const shotBytes = (await page.screenshot()).length;
    console.log(`[smoke] ${i}/${ITERATIONS} OK · title="${title}" · screenshot=${shotBytes}B`);
    ok++;
    await sleep(INTERVAL_MS);
  }
  console.log(`\n[smoke] PASS — headed Chrome rendered ${ok}/${ITERATIONS} times while (presumably) backgrounded.`);
} catch (err) {
  console.error(`\n[smoke] FAIL after ${ok}/${ITERATIONS} — headed Chrome broke in this session:`);
  console.error(err.message || err);
  console.error(`\n[smoke] => fall back to headless (set daemon headless:true) or a dedicated Mac.`);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
