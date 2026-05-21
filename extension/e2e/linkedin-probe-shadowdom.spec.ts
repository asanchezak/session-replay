/**
 * Probe LinkedIn's "interop-shadowdom" container.
 * Discovers: (1) is it a real shadow root or just a styled div, (2) what
 * composedPath() returns at click time for the message Send button, and
 * (3) whether shadowRoot.querySelector can reach the inner interactive
 * element. Output drives the resolveClickTarget redesign.
 *
 * Run: npx playwright test e2e/linkedin-probe-shadowdom.spec.ts --headed
 */
import fs from "fs";
import { test } from "./fixtures";
import { LINKEDIN_STATE_PATH } from "./linkedin-fixtures";

test("probe LinkedIn interop-shadowdom DOM", async ({ context }) => {
  if (!fs.existsSync(LINKEDIN_STATE_PATH)) {
    throw new Error(`No LinkedIn cookies at ${LINKEDIN_STATE_PATH}.`);
  }
  const state = JSON.parse(fs.readFileSync(LINKEDIN_STATE_PATH, "utf-8")) as {
    cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: string }>;
  };
  await context.addCookies(state.cookies);

  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // Open the home Messaging overlay
  const msgBtn = page.locator("button:has-text('Messaging')").first();
  if (await msgBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await msgBtn.click();
    await page.waitForTimeout(1500);
  }

  // Probe DOM
  const probe = await page.evaluate(() => {
    const out: Record<string, unknown> = {};
    const interopList = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="interop-shadowdom"]'));
    out.interopCount = interopList.length;
    out.interopHosts = interopList.map((el) => ({
      tag: el.tagName.toLowerCase(),
      hasShadowRoot: !!el.shadowRoot,
      shadowMode: el.shadowRoot?.mode,
      childCount: el.children.length,
      shadowChildCount: el.shadowRoot ? el.shadowRoot.children.length : 0,
      hasInner: !!el.querySelector("button, [role='button'], [aria-label]"),
      hasInnerInShadow: el.shadowRoot ? !!el.shadowRoot.querySelector("button, [role='button'], [aria-label]") : false,
    }));

    // Walk DOM and count all shadow roots
    let shadowRootCount = 0;
    const walk = (root: ParentNode) => {
      const all = root.querySelectorAll("*");
      for (const node of all) {
        if ((node as HTMLElement).shadowRoot) {
          shadowRootCount++;
          walk((node as HTMLElement).shadowRoot!);
        }
      }
    };
    walk(document);
    out.totalShadowRoots = shadowRootCount;

    // Try to find the Send button explicitly
    const sendInLight = !!document.querySelector("button[aria-label='Send']");
    let sendInShadow: string | null = null;
    const deepFind = (root: ParentNode): Element | null => {
      const direct = root.querySelector("button[aria-label='Send']");
      if (direct) return direct;
      for (const el of root.querySelectorAll("*")) {
        if ((el as HTMLElement).shadowRoot) {
          const r = deepFind((el as HTMLElement).shadowRoot!);
          if (r) return r;
        }
      }
      return null;
    };
    const deep = deepFind(document);
    if (deep) {
      sendInShadow = deep.outerHTML.slice(0, 200);
    }
    out.sendInLight = sendInLight;
    out.sendInShadow = sendInShadow;
    return out;
  });

  console.log("\n========== INTEROP-SHADOWDOM PROBE ==========");
  console.log(JSON.stringify(probe, null, 2));
  console.log("=============================================\n");

  await page.screenshot({ path: "linkedin-debug-shadowdom-probe.png", fullPage: false });
});
