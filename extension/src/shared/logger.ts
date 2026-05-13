const BACKEND_URL = "http://localhost:8081/v1/debug/log";
const LEVELS = { debug: 0, log: 1, warn: 2, error: 3 } as const;
const MIN_LEVEL: number = typeof chrome !== "undefined" && chrome.runtime?.id ? 0 : 1;

let _enabled = true;
let _localBuffer: string[] = [];
let _sendTimer: ReturnType<typeof setTimeout> | null = null;

export function setEnabled(v: boolean) {
  _enabled = v;
}

async function sendToBackend(level: string, args: unknown[], source: string) {
  if (!_enabled) return;
  const text = args.map(a => (typeof a === "object" ? safeStringify(a) : String(a))).join(" ");
  _localBuffer.push(text);

  try {
    await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, level, message: text, timestamp: Date.now() }),
    });
  } catch {
    // silently queue locally if backend unreachable
    scheduleFlush();
  }
}

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 1);
  } catch {
    return String(obj);
  }
}

function scheduleFlush() {
  if (_sendTimer) return;
  _sendTimer = setTimeout(async () => {
    _sendTimer = null;
    if (_localBuffer.length === 0) return;
    const batch = _localBuffer.splice(0);
    try {
      await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "local_buffer", level: "info", messages: batch, timestamp: Date.now() }),
      });
    } catch {
      // give up
    }
  }, 5000);
}

export function getLocalBuffer(): string[] {
  return [..._localBuffer];
}

export function createLogger(source: string) {
  const log = (level: keyof typeof LEVELS, ...args: unknown[]) => {
    if (LEVELS[level] < MIN_LEVEL) return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[${source}]`, ...args);
    sendToBackend(level, args, source);
  };
  return {
    debug: (...args: unknown[]) => log("debug", ...args),
    log: (...args: unknown[]) => log("log", ...args),
    warn: (...args: unknown[]) => log("warn", ...args),
    error: (...args: unknown[]) => log("error", ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
