import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const repoRoot = path.resolve(__dirname, "..");
const harnessRoot = path.resolve(repoRoot, ".local-e2e-sites");

const sourceServer = path.resolve(harnessRoot, "source-site", "server.js");
const destinationServer = path.resolve(harnessRoot, "destination-site", "server.js");

if (!fs.existsSync(sourceServer) || !fs.existsSync(destinationServer)) {
  console.error("Local harness is missing. Expected:");
  console.error(`  ${sourceServer}`);
  console.error(`  ${destinationServer}`);
  process.exit(1);
}

const children = [
  spawn(process.execPath, [sourceServer], { stdio: "inherit", cwd: path.dirname(sourceServer) }),
  spawn(process.execPath, [destinationServer], { stdio: "inherit", cwd: path.dirname(destinationServer) }),
];

console.log("Local cross-site harness started:");
console.log("  Source:      http://127.0.0.1:4311/jobs?page=1");
console.log("  Destination: http://127.0.0.1:4312/intake");
console.log("Press Ctrl+C to stop both servers.");

const shutdown = () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
