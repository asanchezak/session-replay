import { createLogger } from "../shared/logger";
import type { AgentCommand, PageContext, PageDiff } from "../shared/types";
import type {
  CapturePageContextMessage,
  ExecuteAgentCommandMessage,
  PageContextResponse,
  AgentCommandResultResponse,
} from "../shared/messaging";

const log = createLogger("command-executor");

// Phase 2: per-tab cache of the last PageContext so the next capture can
// emit a delta. Cleared automatically when the tab is closed.
const prevContextByTab = new Map<number, PageContext>();

function elementKey(e: PageContext["visible_elements"][number]): string {
  return `${e.tag}|${e.role ?? ""}|${(e.text || "").slice(0, 40)}|${e.aria_label ?? ""}`;
}

function shortDescriptor(e: PageContext["visible_elements"][number]): {
  tag: string; role?: string; text: string;
} {
  return {
    tag: e.tag,
    role: e.role,
    text: (e.text || e.aria_label || "").slice(0, 80),
  };
}

function computeDiff(prev: PageContext, next: PageContext): PageDiff {
  const prevKeys = new Map(prev.visible_elements.map((e) => [elementKey(e), e]));
  const nextKeys = new Map(next.visible_elements.map((e) => [elementKey(e), e]));
  const added: PageDiff["added"] = [];
  const removed: PageDiff["removed"] = [];
  for (const [k, e] of nextKeys) {
    if (!prevKeys.has(k)) added.push(shortDescriptor(e));
  }
  for (const [k, e] of prevKeys) {
    if (!nextKeys.has(k)) removed.push(shortDescriptor(e));
  }
  return {
    url_changed: prev.url !== next.url,
    previous_url: prev.url !== next.url ? prev.url : undefined,
    title_changed: prev.title !== next.title,
    previous_title: prev.title !== next.title ? prev.title : undefined,
    added: added.slice(0, 15),
    removed: removed.slice(0, 15),
  };
}

export class CommandExecutor {
  async captureContext(tabId: number): Promise<PageContext> {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "CAPTURE_PAGE_CONTEXT",
      } as CapturePageContextMessage);
      const result = response as PageContextResponse;
      const ctx: PageContext = {
        url: result.url,
        title: result.title,
        dom_snippet: result.dom_snippet,
        accessibility_tree: result.accessibility_tree,
        visible_text: result.visible_text,
        visible_elements: result.visible_elements as PageContext["visible_elements"],
        is_blocking: result.is_blocking,
        blocking_type: result.blocking_type,
        page_unchanged: false,
        page_diff: null,
      };

      const prev = prevContextByTab.get(tabId);
      if (prev) {
        ctx.page_diff = computeDiff(prev, ctx);
        if (
          !ctx.page_diff.url_changed
          && !ctx.page_diff.title_changed
          && ctx.page_diff.added.length === 0
          && ctx.page_diff.removed.length === 0
        ) {
          ctx.page_unchanged = true;
        }
      }
      prevContextByTab.set(tabId, ctx);

      return ctx;
    } catch (err) {
      log.error("captureContext failed:", err);
      return {
        url: "",
        title: "",
        dom_snippet: "",
        accessibility_tree: "",
        visible_text: "",
        visible_elements: [],
        is_blocking: false,
        blocking_type: null,
        page_unchanged: false,
        page_diff: null,
      };
    }
  }

  /** Clear the cached PageContext for a tab. Call when a run completes or
   *  starts so a fresh run's first poll isn't compared against stale state. */
  clearTabCache(tabId: number): void {
    prevContextByTab.delete(tabId);
  }

  async executeCommand(
    tabId: number,
    command: AgentCommand,
  ): Promise<{ success: boolean; error?: string }> {
    const timeoutMs = command.timeout_ms || 15000;

    try {
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, {
          type: "EXECUTE_AGENT_COMMAND",
          command,
        } as ExecuteAgentCommandMessage),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Command timed out")), timeoutMs)
        ),
      ]);

      const result = response as AgentCommandResultResponse;
      return { success: result.success, error: result.error };
    } catch (err) {
      log.error(`executeCommand ${command.action} failed:`, err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const commandExecutor = new CommandExecutor();
