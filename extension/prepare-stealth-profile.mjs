/**
 * Snapshot the user's real Chrome "Profile 4" into a Playwright-controllable
 * userDataDir at extension/.linkedin-profile/. Includes cookies, history,
 * IndexedDB, Local Storage, Favicons — so the resulting profile has a real
 * Chrome fingerprint and a logged-in LinkedIn session that has aged.
 *
 * Skips the giant caches (Service Worker, WebStorage, Extensions, File System,
 * GPUCache) — Chrome rebuilds them on launch and they balloon the copy.
 *
 * The destination user-data-dir layout Playwright expects:
 *   .linkedin-profile/
 *     Local State        ← top-level encryption metadata
 *     Default/           ← all per-profile data (Cookies, History, etc.)
 *
 * Profile 4's flat structure (no Default subdir, files at the top of the
 * profile dir) gets re-rooted under .linkedin-profile/Default/ so Chrome
 * launches that as the active profile.
 */
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHROME_BASE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);
const SRC_PROFILE = path.join(CHROME_BASE, "Profile 4");
const SRC_LOCAL_STATE = path.join(CHROME_BASE, "Local State");

const DEST_ROOT = path.resolve(__dirname, ".linkedin-profile");
const DEST_DEFAULT = path.join(DEST_ROOT, "Default");

// Items inside a Chrome profile worth copying for fingerprint authenticity.
// Excludes giant caches — Chrome regenerates them.
const PROFILE_INCLUDE = [
  "Cookies",
  "Cookies-journal",
  "History",
  "History-journal",
  "History Provider Cache",
  "Top Sites",
  "Top Sites-journal",
  "Favicons",
  "Favicons-journal",
  "Preferences",
  "Secure Preferences",
  "Bookmarks",
  "Bookmarks.bak",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Local Extension Settings",
  "Shared Dictionary",
  "Visited Links",
  "Network",
  "Network Persistent State",
  "Trust Tokens",
  "Trust Tokens-journal",
  "Web Data",
  "Web Data-journal",
  "Login Data",
  "Login Data-journal",
  "Affiliation Database",
  "Affiliation Database-journal",
];

// Lock / running-state files that prevent Chrome from launching cleanly.
const LOCK_FILES_TO_REMOVE = [
  "SingletonLock",
  "SingletonCookie",
  "SingletonSocket",
  "RunningChromeVersion",
];

function copyEntry(src, dst) {
  if (!fs.existsSync(src)) {
    return false;
  }
  // Use `cp -RP` to preserve symlinks-as-links and avoid following.
  // System cp handles SQLite WAL files atomically enough for our purposes.
  const r = spawnSync("cp", ["-RP", src, dst], { stdio: "inherit" });
  return r.status === 0;
}

function rmRf(p) {
  spawnSync("rm", ["-rf", p]);
}

function clearLocks(profileDir) {
  for (const f of LOCK_FILES_TO_REMOVE) {
    rmRf(path.join(profileDir, f));
  }
  // Recursively clear *Lock and LOCK files left by chrome storage subsystems.
  const r = spawnSync(
    "find",
    [profileDir, "-name", "LOCK", "-o", "-name", "lockfile"],
    { encoding: "utf-8" },
  );
  if (r.stdout) {
    for (const f of r.stdout.split("\n").filter(Boolean)) {
      rmRf(f);
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(SRC_PROFILE)) {
  console.error(`Source profile not found: ${SRC_PROFILE}`);
  process.exit(1);
}

// Pre-flight: Chrome MUST be fully quit before snapshotting. Copying live
// SQLite databases (Cookies/History) mid-write captures a half-written WAL,
// which Chrome then rebuilds on launch — yielding what looks like a brand-new,
// historyless profile, which is itself an anti-bot flag. Refuse to stage a
// corrupt snapshot. Override with ALLOW_CHROME_RUNNING=1 if you know better.
{
  const probe = spawnSync("pgrep", ["-x", "Google Chrome"], { encoding: "utf-8" });
  const running = (probe.stdout || "").trim().length > 0;
  if (running && process.env.ALLOW_CHROME_RUNNING !== "1") {
    console.error(
      "Chrome is currently running. Quit Chrome completely (Cmd-Q) before staging —\n" +
      "snapshotting a live profile corrupts Cookies/History and produces a\n" +
      "historyless profile that LinkedIn is more likely to flag.\n" +
      "Re-run after quitting, or set ALLOW_CHROME_RUNNING=1 to override.",
    );
    process.exit(1);
  }
}

// Wipe any previous staged profile.
rmRf(DEST_ROOT);
fs.mkdirSync(DEST_DEFAULT, { recursive: true });

console.log(`Snapshotting ${SRC_PROFILE}`);
console.log(`  -> ${DEST_DEFAULT}`);

let copied = 0;
let skipped = 0;
for (const entry of PROFILE_INCLUDE) {
  const src = path.join(SRC_PROFILE, entry);
  const dst = path.join(DEST_DEFAULT, entry);
  if (copyEntry(src, dst)) {
    copied++;
  } else {
    skipped++;
  }
}
console.log(`Copied ${copied} entries (${skipped} not present in source).`);

// Top-level files Chrome looks for at the user-data-dir root.
console.log(`Copying Local State -> ${DEST_ROOT}/Local State`);
copyEntry(SRC_LOCAL_STATE, path.join(DEST_ROOT, "Local State"));

console.log("Clearing lock files...");
clearLocks(DEST_ROOT);
clearLocks(DEST_DEFAULT);

// Patch Preferences so Chrome doesn't show "Chrome didn't shut down correctly"
// (which would change page load behaviour and ping LinkedIn extra times).
const prefsPath = path.join(DEST_DEFAULT, "Preferences");
try {
  const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
  if (prefs.profile) {
    prefs.profile.exit_type = "Normal";
    prefs.profile.exited_cleanly = true;
  }
  if (prefs.browser) prefs.browser.has_seen_welcome_page = true;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  console.log("Patched Preferences for clean exit state.");
} catch (err) {
  console.warn("Could not patch Preferences:", err?.message || err);
}

const du = spawnSync("du", ["-sh", DEST_ROOT], { encoding: "utf-8" });
console.log("Staged profile size:", (du.stdout || "").trim());
console.log("Done.");
