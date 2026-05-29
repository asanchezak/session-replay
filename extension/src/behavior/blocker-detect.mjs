/**
 * LinkedIn wall / challenge detection for the Playwright daemon. Port of the
 * extension's src/shared/detector.ts (which is browser-context DOM code) into
 * a Playwright-page helper, so the daemon can detect blockers on EVERY
 * navigation and pause the run instead of plowing through.
 *
 * Kept in its own module so it is unit-testable against fixture pages without
 * importing the daemon (which runs a top-level poll loop on import).
 */

// URL-shape check (cheap, runs before the DOM probe).
export function isBlockerUrl(url) {
  return /\/checkpoint\/|\/uas\/login|\/login\?|\/login$|authwall|\/challenge/i.test(url || "");
}

// DOM probe — returns { type, confidence } for the first wall found, else null.
// `page` is a Playwright Page. Safe to call on any loaded page.
export async function detectChallengeInPage(page) {
  try {
    return await page.evaluate(() => {
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width >= 20 && rect.height >= 20;
      };
      // captcha
      for (const sel of ['iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[src*="turnstile"]', "[data-sitekey]"]) {
        const el = document.querySelector(sel);
        if (el && visible(el)) return { type: "captcha", confidence: 0.95 };
      }
      for (const el of document.querySelectorAll('div[class*="captcha" i], div[id*="captcha" i]')) {
        if (visible(el) && /captcha|verify you are human|not a robot/i.test(el.innerText || "")) return { type: "captcha", confidence: 0.9 };
      }
      // login form — a visible password field
      const pw = Array.from(document.querySelectorAll('input[type="password"]')).filter((f) => {
        const s = window.getComputedStyle(f);
        return s.display !== "none" && s.visibility !== "hidden";
      });
      if (pw.length > 0) return { type: "login_form", confidence: 0.9 };
      // two-factor / one-time code
      for (const sel of ['input[name*="code"]', 'input[name*="token"]', 'input[name*="2fa"]', 'input[name*="totp"]', 'input[name*="mfa"]', 'input[autocomplete="one-time-code"]']) {
        const el = document.querySelector(sel);
        if (el) {
          const name = (el.name || "").toLowerCase();
          const id = (el.id || "").toLowerCase();
          if (/promo|coupon|discount/.test(name) || /promo|coupon|discount/.test(id)) continue;
          return { type: "two_factor", confidence: 0.9 };
        }
      }
      return null;
    });
  } catch {
    return null;
  }
}
