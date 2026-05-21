/**
 * Probe LinkedIn's messaging dock state.
 *  - Open /feed/, log dock state (open/closed, button position)
 *  - Trigger a manual click on the dock toggle (via Playwright trusted click)
 *  - Wait, log dock state again
 *  - Look for conversation cards in DOM
 *
 * Goal: understand what makes the dock reliably open vs not.
 */
import fs from "fs";
import { test } from "./fixtures";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

test("probe LinkedIn dock toggle behavior", async ({ context }) => {
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: string }>;
  };
  await context.addCookies(state.cookies);

  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Initial dock state
  const initial = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('div[data-testid="interop-shadowdom"]');
    const sr = host?.shadowRoot;
    const button = sr?.querySelector<HTMLElement>("#msg-overlay-list-bubble-header__button");
    const rect = button?.getBoundingClientRect();
    const ariaLabel = button?.getAttribute("aria-label");
    // Look for conversation cards
    const cards = sr?.querySelectorAll('li.msg-conversation-listitem, [data-control-name="overlay_list_item"]');
    return {
      hostExists: !!host,
      hasShadowRoot: !!sr,
      buttonExists: !!button,
      buttonRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      buttonAriaLabel: ariaLabel?.slice(0, 60),
      cardCount: cards?.length || 0,
    };
  });
  console.log("\n=== INITIAL ===\n" + JSON.stringify(initial, null, 2));

  // Click the dock button via Playwright (trusted)
  if (initial.buttonRect) {
    const x = initial.buttonRect.x + initial.buttonRect.w / 2;
    const y = initial.buttonRect.y + initial.buttonRect.h / 2;
    console.log(`\nPlaywright trusted-clicking at (${x}, ${y})`);
    await page.mouse.click(x, y);
  }

  // Wait and re-probe at intervals
  await page.waitForTimeout(3000);
  const franzScan = await page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('div[data-testid="interop-shadowdom"]');
    const sr = host?.shadowRoot;
    if (!sr) return { err: "no shadow root" };

    // Deep-walk shadow roots and collect any clickable thing that mentions "Franz"
    const matches: Array<{ tag: string; text: string; selector: string; depth: number }> = [];
    const walk = (root: ParentNode, depth: number) => {
      const all = root.querySelectorAll("*");
      for (const el of all) {
        const text = el.textContent?.replace(/\s+/g, " ").trim() || "";
        if (text.includes("Franz") && text.length < 300) {
          matches.push({
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 100),
            selector: el.id ? `#${el.id}` : (el.className ? "." + (el.className + "").toString().split(" ")[0] : ""),
            depth,
          });
        }
        const innerSr = (el as HTMLElement).shadowRoot;
        if (innerSr) walk(innerSr, depth + 1);
      }
    };
    walk(document, 0);

    // Also list distinct LI selectors inside shadow root
    const lis = Array.from(sr.querySelectorAll("li")).slice(0, 5).map(li => ({
      classes: (li.className + "").split(" ").slice(0, 3),
      text: (li.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50),
    }));

    // Try elementFromPoint at the area where the conversation list should be
    const fromPoint = document.elementFromPoint(1100, 250);
    const fromPointDeep = (() => {
      let el = fromPoint;
      const path: string[] = [];
      while (el) {
        path.push(`${el.tagName}.${(el.className + "").split(" ")[0] || "_"}`);
        const sr2 = (el as HTMLElement).shadowRoot;
        if (sr2) {
          path.push("→shadow→");
          const inside = sr2.elementFromPoint(1100, 250);
          if (inside && inside !== el) { el = inside; continue; }
        }
        break;
      }
      return path;
    })();

    // Search ALL shadow roots in the document (deep)
    const deepFranz: Array<{ depth: number; tag: string; text: string }> = [];
    const allShadows: Array<{ host: string; depth: number; childCount: number }> = [];
    const walkShadow = (root: ShadowRoot | Document, depth: number) => {
      for (const el of root.querySelectorAll("*")) {
        const innerSr = (el as HTMLElement).shadowRoot;
        if (innerSr) {
          allShadows.push({
            host: (el.id ? `#${el.id}` : el.tagName) + (el.getAttribute("data-testid") ? `[testid=${el.getAttribute("data-testid")}]` : ""),
            depth,
            childCount: innerSr.querySelectorAll("*").length,
          });
          walkShadow(innerSr, depth + 1);
          for (const inner of innerSr.querySelectorAll("*")) {
            const t = inner.textContent?.replace(/\s+/g, " ").trim() || "";
            if (t.includes("Franz") && t.length < 200) {
              deepFranz.push({ depth: depth + 1, tag: inner.tagName.toLowerCase(), text: t.slice(0, 80) });
            }
          }
        }
      }
    };
    walkShadow(document, 0);

    return {
      matches: matches.slice(0, 3),
      liCount: sr.querySelectorAll("li").length,
      lis,
      fromPointDeep,
      allShadows: allShadows.slice(0, 10),
      deepFranzCount: deepFranz.length,
      deepFranzSample: deepFranz.slice(0, 3),
    };
  });
  console.log("\n=== After 3000ms — Franz scan ===\n" + JSON.stringify(franzScan, null, 2));

  await page.screenshot({ path: "dock-state-probe.png", fullPage: false });
  console.log("\nScreenshot: dock-state-probe.png");
});
