import type { SiteAdapterHarnessResult } from "./types";
import { LINKEDIN_DETAIL_SECTIONS } from "../../behavior/stealth-core.mjs";

export type SiteSnapshotTarget = {
  sectionName: string;
  pageUrl: string;
};

export function getLinkedInProfileSnapshotTargets(url: string): SiteSnapshotTarget[] {
  try {
    const parsed = new URL(url);
    if (!/linkedin\.com$/i.test(parsed.hostname) && !/\.linkedin\.com$/i.test(parsed.hostname)) {
      return [];
    }
    const match = parsed.pathname.match(/^\/in\/([^/]+)\/?$/i);
    if (!match) return [];
    const basePath = `/in/${match[1]}/`;
    return LINKEDIN_DETAIL_SECTIONS.map((sectionName) => ({
      sectionName,
      pageUrl: new URL(`${basePath}details/${sectionName}/`, parsed.origin).toString(),
    }));
  } catch {
    return [];
  }
}

export function LINKEDIN_SITE_HARNESS(args: Record<string, unknown>): SiteAdapterHarnessResult {
  const operation = String(args?.operation || "").trim();
  const scope = String(args?.scope || "any").trim();
  const label = String(args?.label || "").trim();
  const name = String(args?.name || "").trim();
  const text = String(args?.text || "");

  const normalize = (value: unknown): string =>
    String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const textFor = (el: Element): string =>
    (
      (el.getAttribute("aria-label") || "") + " " +
      (el.getAttribute("title") || "") + " " +
      (el.getAttribute("data-testid") || "") + " " +
      ("value" in el ? String((el as HTMLInputElement).value || "") : "") + " " +
      (el.textContent || "")
    ).replace(/\s+/g, " ").trim();

  const isVisible = (el: Element | null): boolean => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };

  const isDisabled = (el: Element | null): boolean => {
    if (!el) return false;
    if (
      el instanceof HTMLButtonElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      return el.disabled;
    }
    return el.getAttribute("aria-disabled") === "true";
  };

  const deepQuerySelectorAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    try { out.push(...Array.from(root.querySelectorAll(selector))); } catch { return out; }
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) out.push(...deepQuerySelectorAll(selector, sr));
    }
    return out;
  };

  const deepQuerySelector = (selector: string, root: ParentNode = document): Element | null => {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch { return null; }
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const sr = (node as HTMLElement).shadowRoot;
      if (!sr) continue;
      const found = deepQuerySelector(selector, sr);
      if (found) return found;
    }
    return null;
  };

  const messagingHost = deepQuerySelector('div[data-testid="interop-shadowdom"]');
  const messagingRoot = messagingHost ? ((messagingHost as HTMLElement).shadowRoot || messagingHost) : null;
  const navRoot = document.querySelector("header, nav, [role='navigation']") || document;
  const mainRoot = document.querySelector("main, [role='main']") || document;
  const messagingSurfaceRoots = (): ParentNode[] => messagingRoot ? [messagingRoot] : [mainRoot, document];
  const rootsForScope = (): ParentNode[] => {
    if (scope === "messaging_dock") return messagingRoot ? [messagingRoot] : [];
    if (scope === "global_nav") return [navRoot];
    if (scope === "main_content") return [mainRoot];
    const roots: ParentNode[] = [navRoot, mainRoot, document];
    if (messagingRoot) roots.unshift(messagingRoot);
    return roots;
  };

  const measure = (el: Element | null, reason: string, action: "click" | "type", insertText?: string, settleMs?: number): SiteAdapterHarnessResult => {
    if (!el || !isVisible(el) || isDisabled(el)) {
      return { ok: false, operation, error: "LINKEDIN_SITE_NO_TARGET", debug: { reason, scope, hasMessagingRoot: !!messagingRoot } };
    }
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /**/ }
    const rect = el.getBoundingClientRect();
    return {
      ok: true,
      operation,
      action,
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      tag: el.tagName,
      text: textFor(el).slice(0, 180),
      reason,
      insertText,
      settleMs,
    };
  };

  const noop = (reason: string, settleMs = 500): SiteAdapterHarnessResult => ({
    ok: true,
    operation,
    action: "noop",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    tag: "NOOP",
    text: reason,
    reason,
    settleMs,
  });

  const navigate = (targetUrl: string, reason: string, settleMs = 1800): SiteAdapterHarnessResult => ({
    ok: true,
    operation,
    action: "navigate",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    tag: "LOCATION",
    text: targetUrl,
    reason,
    targetUrl,
    settleMs,
  });

  const bestActionable = (node: Element | null, preferConversation = false): Element | null => {
    if (!node) return null;
    if (preferConversation) {
      let cur: Element | null = node;
      for (let depth = 0; depth < 12 && cur; depth++) {
        const cls = (typeof cur.className === "string" ? cur.className : "").toLowerCase();
        const role = (cur.getAttribute("role") || "").toLowerCase();
        if (
          isVisible(cur) &&
          !isDisabled(cur) &&
          (cls.includes("conversation") || cls.includes("thread") || cls.includes("list-item") || role === "listitem" || role === "option")
        ) {
          return cur;
        }
        cur = cur.parentElement;
      }
    }
    let cur: Element | null = node;
    for (let depth = 0; depth < 8 && cur; depth++) {
      const role = (cur.getAttribute("role") || "").toLowerCase();
      if (
        isVisible(cur) &&
        !isDisabled(cur) &&
        (cur.matches("button,a,input,textarea,select,summary,label,[tabindex],[onclick]") || role === "button" || role === "link" || role === "option")
      ) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return isVisible(node) ? node : null;
  };

  const findByText = (needle: string, roots: ParentNode[], options: { actionableOnly?: boolean; preferConversation?: boolean } = {}): Element | null => {
    const needleN = normalize(needle);
    if (!needleN) return null;
    const query = options.actionableOnly
      ? "button,a,[role='button'],[role='link'],[role='option'],input,textarea,select,[tabindex],[onclick]"
      : "button,a,[role='button'],[role='link'],[role='option'],input,textarea,select,[tabindex],[onclick],span,div,p,li,strong,b,h1,h2,h3,h4,h5,h6";
    let best: Element | null = null;
    let bestScore = -1;
    for (const root of roots) {
      for (const el of deepQuerySelectorAll(query, root)) {
        if (!isVisible(el) || isDisabled(el)) continue;
        const txt = textFor(el);
        const txtN = normalize(txt);
        if (!txtN || (!txtN.includes(needleN) && !needleN.includes(txtN))) continue;
        const target = bestActionable(el, !!options.preferConversation);
        if (!target) continue;
        let score = 0;
        if (txtN === needleN) score += 120;
        if (txtN.includes(needleN)) score += 70;
        if (target.tagName === "BUTTON") score += 25;
        if (options.preferConversation) score += target === el ? 5 : 30;
        if (score > bestScore) {
          bestScore = score;
          best = target;
        }
      }
    }
    return best;
  };

  const linkedinNavHrefByLabel: Record<string, string[]> = {
    home: ["/feed"],
    "my network": ["/mynetwork"],
    jobs: ["/jobs"],
    messaging: ["/messaging"],
    notifications: ["/notifications"],
    me: ["/in/", "/mynetwork/invite-connect/connections"],
  };
  const linkedinNavRouteByLabel: Record<string, string> = {
    home: "/feed/",
    "my network": "/mynetwork/",
    jobs: "/jobs/",
    messaging: "/messaging/",
    notifications: "/notifications/",
  };

  const hrefMatches = (href: string, fragments: string[]): boolean => {
    const raw = href.toLowerCase();
    let pathname = raw;
    try {
      pathname = new URL(href, window.location.href).pathname.toLowerCase();
    } catch {
      // Keep the raw href fallback for relative or malformed hrefs.
    }
    return fragments.some((fragment) => pathname.startsWith(fragment) || raw.includes(fragment));
  };

  const findGlobalNavTarget = (needle: string): Element | null => {
    const needleN = normalize(needle);
    const fragments = linkedinNavHrefByLabel[needleN];
    if (fragments?.length) {
      let best: Element | null = null;
      let bestScore = -1;
      const roots: ParentNode[] = navRoot === document ? [document] : [navRoot, document];
      for (const root of roots) {
        for (const link of deepQuerySelectorAll("a[href]", root)) {
          if (isDisabled(link)) continue;
          const href = link.getAttribute("href") || (link as HTMLAnchorElement).href || "";
          if (!hrefMatches(href, fragments)) continue;
          const visibleTarget = isVisible(link)
            ? link
            : deepQuerySelectorAll("span,svg,div,li,strong", link).find((child) => isVisible(child));
          if (!visibleTarget) continue;
          const txtN = normalize(textFor(link));
          let score = 100;
          if (txtN === needleN) score += 40;
          if (txtN.includes(needleN)) score += 25;
          if (root === navRoot) score += 15;
          if (link.closest("header, nav, [role='navigation']")) score += 20;
          if (score > bestScore) {
            bestScore = score;
            best = bestActionable(visibleTarget) || visibleTarget;
          }
        }
      }
      if (best) return best;
    }
    return findByText(needle, [navRoot], { actionableOnly: true });
  };

  const findComposer = (): Element | null => {
    const selectors = [
      '[role="textbox"][aria-label*="Write" i]',
      '[role="textbox"][aria-label*="message" i]',
      '[contenteditable="true"][aria-label*="message" i]',
      ".msg-form__contenteditable",
      '[contenteditable="true"]',
    ];
    for (const root of messagingSurfaceRoots()) {
      for (const selector of selectors) {
        const found = deepQuerySelector(selector, root);
        if (found && isVisible(found) && !isDisabled(found)) return found;
      }
    }
    return null;
  };

  const findSendButton = (): Element | null => {
    const selectors = [
      "button.msg-form__send-button[type='submit']",
      "button[type='submit'][class*='send']",
      "button[class*='send']",
      "button[type='submit']",
    ];
    for (const root of messagingSurfaceRoots()) {
      for (const selector of selectors) {
        const found = deepQuerySelector(selector, root);
        if (found && isVisible(found) && !isDisabled(found)) return found;
      }
    }
    return findByText("Send", messagingSurfaceRoots(), { actionableOnly: true });
  };

  if (operation === "open_messaging_dock") {
    if (!messagingRoot) {
      const origin = window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : "https://www.linkedin.com";
      return navigate(new URL("/messaging/", origin).toString(), "linkedin_open_messaging_page", 2200);
    }
    const openMarker = messagingRoot
      ? deepQuerySelector("[class*='conversation'],[class*='msg-overlay-list-bubble-search'],[role='list']", messagingRoot)
      : null;
    if (openMarker && isVisible(openMarker)) {
      return noop("linkedin_messaging_dock_already_open", 500);
    }
    const roots = messagingRoot ? [messagingRoot, navRoot] : [navRoot, document];
    const target =
      (messagingRoot && (
        deepQuerySelector("#msg-overlay-list-bubble-header__button", messagingRoot) ||
        findByText("Messaging", [messagingRoot], { actionableOnly: true })
      )) ||
      findByText("Messaging", roots, { actionableOnly: true });
    return measure(target, "linkedin_open_messaging_dock", "click", undefined, 1800);
  }

  if (operation === "open_conversation") {
    const target = findByText(name, messagingSurfaceRoots(), { preferConversation: true });
    if (!target && !messagingRoot) return { ok: false, operation, error: "LINKEDIN_SITE_NO_MESSAGING_ROOT" };
    return measure(target, "linkedin_open_conversation", "click", undefined, 3000);
  }

  if (operation === "focus_message_composer") {
    return measure(findComposer(), "linkedin_focus_message_composer", "click", undefined, 500);
  }

  if (operation === "type_message") {
    const composer = findComposer();
    if (composer && normalize(textFor(composer)).includes(normalize(text))) {
      return measure(composer, "linkedin_message_already_present", "click", undefined, 150);
    }
    return measure(composer, "linkedin_type_message", "type", text, 500);
  }

  if (operation === "send_message") {
    return measure(findSendButton(), "linkedin_send_message", "click", undefined, 1800);
  }

  if (operation === "click") {
    const target = scope === "global_nav"
      ? findGlobalNavTarget(label)
      : findByText(label, rootsForScope(), { actionableOnly: false });
    const route = scope === "global_nav" ? linkedinNavRouteByLabel[normalize(label)] : "";
    if (!target && route) {
      const origin = window.location.origin && window.location.origin !== "null"
        ? window.location.origin
        : "https://www.linkedin.com";
      return navigate(new URL(route, origin).toString(), "linkedin_scoped_route_navigation", 1800);
    }
    return measure(target, "linkedin_scoped_click", "click", undefined, 1000);
  }

  return { ok: false, operation, error: "LINKEDIN_SITE_UNKNOWN_OPERATION", debug: { operation, scope } };
}

export function recoverLinkedInMissingDependency(
  operation: string,
  failed: Extract<SiteAdapterHarnessResult, { ok: false }>,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  if (failed.error !== "LINKEDIN_SITE_NO_MESSAGING_ROOT" || operation === "open_messaging_dock") {
    return null;
  }
  return { ...args, operation: "open_messaging_dock", scope: "global_nav" };
}
