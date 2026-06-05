/**
 * EXTRACTOR — run in Fernanda's PERSONAL Chrome session (the one logged into
 * LinkedIn Recruiter). Dumps the linkedin.com cookies in PLAINTEXT so they can
 * be transplanted into the daemon's .linkedin-profile.
 *
 * It connects over CDP to a Chrome that was relaunched with
 * --remote-debugging-port=9333 (see extract-talent-cookies.bat). Chrome itself
 * decrypts the cookies (DPAPI/App-Bound under Fernanda's user), so CDP returns
 * cleartext values — no DPAPI key needed on our side.
 *
 * Read-only: it does NOT navigate, click, or touch the account. Just reads the
 * cookie store and writes JSON. Does NOT close Fernanda's Chrome.
 *
 * Output: C:\Users\Public\extension\.transplant\{talent-cookies.json, EXTRACT-STATUS}
 */
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = "C:/Users/Public/extension/.transplant";
mkdirSync(OUT, { recursive: true });

let browser;
try {
  browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
} catch (e) {
  writeFileSync(OUT + "/EXTRACT-STATUS", "ERROR: could not connect to Chrome on :9333\n" + (e && e.message) + "\n");
  console.error("Could not connect to Chrome debug port 9333. Did the .bat relaunch Chrome?");
  process.exit(1);
}

const all = [];
for (const ctx of browser.contexts()) {
  try { all.push(...(await ctx.cookies())); } catch {}
}
const li = all.filter((c) => /linkedin\.com$/.test(c.domain) || /linkedin/.test(c.domain));
const names = [...new Set(li.map((c) => c.name))].sort();
const seat = ["li_at", "li_a", "liap", "li_rm", "JSESSIONID", "lidc", "bcookie", "bscookie"].filter((n) => names.includes(n));

writeFileSync(OUT + "/talent-cookies.json", JSON.stringify(li, null, 2));
writeFileSync(
  OUT + "/EXTRACT-STATUS",
  `count=${li.length}\n` +
    `has_li_at=${names.includes("li_at")}\n` +
    `has_li_a=${names.includes("li_a")}   <-- Recruiter seat cookie; must be true\n` +
    `seat_cookies_present=${seat.join(",")}\n` +
    `all_names=${names.join(",")}\n` +
    `ts=${new Date().toISOString()}\n`
);

console.log(`Extracted ${li.length} linkedin cookies.`);
console.log(`li_at=${names.includes("li_at")}  li_a=${names.includes("li_a")} (Recruiter seat)`);
if (!names.includes("li_a")) {
  console.log("\n*** WARNING: li_a (Recruiter seat cookie) NOT found in this profile.");
  console.log("*** This Chrome profile may not be the one signed into Recruiter/Talent.");
  console.log("*** Open the profile where /talent/home works, then re-run the .bat.\n");
}
await browser.close().catch(() => {}); // disconnect CDP only; does NOT close Fernanda's Chrome
process.exit(0);
