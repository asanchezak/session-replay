import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const repoRoot = path.resolve(__dirname, "..");
const harnessRoot = path.resolve(repoRoot, ".local-e2e-sites");
const serverPath = path.resolve(harnessRoot, "candidate-forum-site", "server.js");

if (!fs.existsSync(serverPath)) {
  console.error("Local connector forum harness is missing.");
  console.error(`Expected: ${serverPath}`);
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], {
  stdio: "inherit",
  cwd: path.dirname(serverPath),
});

console.log("Local connector forum harness started:");
console.log("  Forum: http://127.0.0.1:4320/");
console.log("Press Ctrl+C to stop.");

const shutdown = () => {
  if (!child.killed) child.kill("SIGTERM");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
