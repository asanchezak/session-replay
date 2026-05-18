import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.resolve(__filename, "..");
const REPO_ROOT = path.resolve(__dirname, "../../..");

export const LOCAL_HARNESS_ROOT = path.resolve(REPO_ROOT, ".local-e2e-sites");
const SOURCE_SERVER_PATH = path.resolve(LOCAL_HARNESS_ROOT, "source-site", "server.js");
const DESTINATION_SERVER_PATH = path.resolve(LOCAL_HARNESS_ROOT, "destination-site", "server.js");

export const SOURCE_ORIGIN = "http://127.0.0.1:4311";
export const DESTINATION_ORIGIN = "http://127.0.0.1:4312";
export const SOURCE_JOBS_URL = `${SOURCE_ORIGIN}/jobs?page=1`;

type SourceState = {
  exportedCount: number;
  exportedJobIds: string[];
};

type DestinationRecord = {
  jobId: string;
  title: string;
  company: string;
  description: string;
};

type DestinationState = {
  createdCount: number;
  createdJobIds: string[];
  records: DestinationRecord[];
};

const startedChildren: ChildProcess[] = [];

export function hasLocalHarness(): boolean {
  return fs.existsSync(SOURCE_SERVER_PATH) && fs.existsSync(DESTINATION_SERVER_PATH);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isReady(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForReady(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(origin)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${origin} to become ready`);
}

function spawnServer(serverPath: string): ChildProcess {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    stdio: "pipe",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(String(chunk));
  });
  child.unref();

  return child;
}

export async function ensureLocalHarnessRunning(): Promise<void> {
  if (!hasLocalHarness()) {
    throw new Error(
      `Local harness not found. Expected ${SOURCE_SERVER_PATH} and ${DESTINATION_SERVER_PATH}`,
    );
  }

  const sourceReady = await isReady(SOURCE_ORIGIN);
  const destinationReady = await isReady(DESTINATION_ORIGIN);
  if (sourceReady && destinationReady) return;

  if (!sourceReady) startedChildren.push(spawnServer(SOURCE_SERVER_PATH));
  if (!destinationReady) startedChildren.push(spawnServer(DESTINATION_SERVER_PATH));

  await Promise.all([
    waitForReady(SOURCE_ORIGIN, 10_000),
    waitForReady(DESTINATION_ORIGIN, 10_000),
  ]);
}

export async function stopLocalHarness(): Promise<void> {
  while (startedChildren.length > 0) {
    const child = startedChildren.pop();
    if (!child || child.killed) continue;
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore process teardown failures for local-only helpers.
    }
  }
}

async function postJson<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

export async function resetLocalHarness(): Promise<void> {
  await Promise.all([
    postJson(`${SOURCE_ORIGIN}/api/reset`),
    postJson(`${DESTINATION_ORIGIN}/api/reset`),
  ]);
}

export async function getSourceState(): Promise<SourceState> {
  return getJson<SourceState>(`${SOURCE_ORIGIN}/api/state`);
}

export async function getDestinationState(): Promise<DestinationState> {
  return getJson<DestinationState>(`${DESTINATION_ORIGIN}/api/state`);
}
