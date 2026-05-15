/**
 * Centralized frontend logger — sends structured logs to backend (→ Seq).
 *
 * Usage:
 *   import { logger } from "../lib/logger";
 *   logger.info("WorkflowsPage", "fetch_workflows", { count: 10 });
 *   logger.error("RunDetailPage", "handlePause", { runId: "abc" }, err);
 *   logger.pageView("/workflows");
 *   logger.userAction("WorkflowsPage", "click_row", { workflowId: "wf-1" });
 */

const API_BASE = import.meta.env.VITE_API_URL || "/v1";
const API_KEY = import.meta.env.VITE_API_KEY;

type LogLevel = "verbose" | "debug" | "info" | "warn" | "error" | "fatal";

interface LogEntry {
  component: string;
  action: string;
  level: LogLevel;
  status: "success" | "failure";
  details?: Record<string, unknown>;
  elapsed_ms?: number;
}

class FrontendLogger {
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 3000;

  private async send(entry: LogEntry): Promise<void> {
    this.buffer.push(entry);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL);
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    // Send individually for simplicity (Seq handles dedup)
    for (const entry of batch) {
      try {
        await fetch(`${API_BASE}/logs/client`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": API_KEY || "",
          },
          body: JSON.stringify(entry),
        });
      } catch {
        // Don't block the app on log failures
      }
    }
  }

  // Force flush (call before page unload)
  flushSync(): void {
    this.flush();
  }

  // ── Convenience methods ──────────────────────────────────────

  info(component: string, action: string, details?: Record<string, unknown>): void {
    this.send({ component, action, level: "info", status: "success", details });
  }

  warn(component: string, action: string, details?: Record<string, unknown>): void {
    this.send({ component, action, level: "warn", status: "failure", details });
  }

  error(component: string, action: string, details?: Record<string, unknown>, err?: Error): void {
    this.send({
      component,
      action,
      level: "error",
      status: "failure",
      details: { ...details, error_message: err?.message, error_name: err?.name },
    });
  }

  pageView(path: string): void {
    this.send({
      component: "AppShell",
      action: "page_view",
      level: "info",
      status: "success",
      details: { path },
    });
  }

  userAction(component: string, action: string, details?: Record<string, unknown>): void {
    this.send({ component, action, level: "info", status: "success", details });
  }

  apiCall(
    component: string,
    method: string,
    path: string,
    statusCode: number,
    elapsedMs: number,
  ): void {
    const status = statusCode >= 400 ? "failure" : "success";
    const level: LogLevel = statusCode >= 400 ? "warn" : "info";
    this.send({
      component,
      action: `${method} ${path}`,
      level,
      status,
      details: { method, path, status_code: statusCode },
      elapsed_ms: elapsedMs,
    });
  }
}

export const logger = new FrontendLogger();

// Auto-flush on page unload
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => logger.flushSync());
}
