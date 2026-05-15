export interface ChallengeDetection {
  detected: boolean;
  type: ChallengeType | null;
  confidence: number;
  description: string | null;
}

export type ChallengeType =
  | "captcha"
  | "login_form"
  | "two_factor"
  | "unexpected_modal"
  | "element_missing";

function checkCaptcha(): ChallengeDetection {
  const captchaSelectors = [
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha"]',
    'iframe[src*="turnstile"]',
    'div[class*="captcha"]',
    'div[id*="captcha"]',
    '[data-sitekey]',
  ];

  for (const sel of captchaSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      return {
        detected: true,
        type: "captcha",
        confidence: 0.95,
        description: "CAPTCHA challenge detected on page",
      };
    }
  }
  return { detected: false, type: null, confidence: 0, description: null };
}

function checkLoginForm(): ChallengeDetection {
  const passwordFields = document.querySelectorAll<HTMLInputElement>(
    'input[type="password"]',
  );
  const visiblePasswordFields = Array.from(passwordFields).filter((f) => {
    const style = window.getComputedStyle(f);
    return style.display !== "none" && style.visibility !== "hidden";
  });
  if (visiblePasswordFields.length > 0) {
    const hasUsernameField = document.querySelector<HTMLInputElement>(
      'input[type="email"], input[name="username"], input[name="login"], input[name="email"]',
    );
    return {
      detected: true,
      type: "login_form",
      confidence: hasUsernameField ? 0.95 : 0.8,
      description: `Login form detected with ${visiblePasswordFields.length} password field(s)`,
    };
  }
  return { detected: false, type: null, confidence: 0, description: null };
}

function checkTwoFactor(): ChallengeDetection {
  const tfaSelectors = [
    'input[name*="code"]',
    'input[name*="token"]',
    'input[name*="2fa"]',
    'input[name*="totp"]',
    'input[name*="mfa"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
  ];

  for (const sel of tfaSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const input = el as HTMLInputElement;
      const name = (input.name || "").toLowerCase();
      const id = (input.id || "").toLowerCase();
      const label = document.querySelector(`label[for="${input.id}"]`)?.textContent?.toLowerCase() || "";
      if (
        name.includes("promo") || name.includes("coupon") || name.includes("discount") ||
        id.includes("promo") || id.includes("coupon") || id.includes("discount") ||
        label.includes("promo") || label.includes("coupon") || label.includes("discount")
      ) {
        continue;
      }
      return {
        detected: true,
        type: "two_factor",
        confidence: 0.9,
        description: "2FA / MFA challenge detected",
      };
    }
  }
  return { detected: false, type: null, confidence: 0, description: null };
}

function checkUnexpectedModal(): ChallengeDetection {
  const modals = document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="alertdialog"], .modal, .overlay',
  );

  for (const modal of modals) {
    const style = window.getComputedStyle(modal);
    if (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      modal.offsetWidth > 0
    ) {
      return {
        detected: true,
        type: "unexpected_modal",
        confidence: 0.85,
        description: `Unexpected modal dialog detected: ${modal.getAttribute("role") || "modal"}`,
      };
    }
  }
  return { detected: false, type: null, confidence: 0, description: null };
}

export function detectChallenges(): ChallengeDetection[] {
  const results = [
    checkCaptcha(),
    checkLoginForm(),
    checkTwoFactor(),
    checkUnexpectedModal(),
  ];

  return results.filter((r) => r.detected);
}

export function hasActiveChallenge(): ChallengeDetection | null {
  const challenges = detectChallenges();
  return challenges.length > 0 ? challenges[0] : null;
}
