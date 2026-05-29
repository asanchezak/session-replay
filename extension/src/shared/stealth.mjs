/**
 * Shared, minimal stealth init bundle for a REAL Chrome binary on the real
 * machine (Playwright `channel: "chrome"` + a staged, aged user profile).
 *
 * Guiding principle: the native fingerprint of real Chrome on this physical
 * Mac is already a perfect, internally-consistent human fingerprint. We must
 * spoof ONLY the things automation actively breaks, and touch nothing Chrome
 * already reports correctly. Over-spoofing (faking WebGL, plugins, CPU/memory,
 * locale) replaces correct native values with guessed ones and creates
 * cross-checkable contradictions — e.g. a hardcoded "Intel Iris" WebGL renderer
 * on an Apple-Silicon Mac whose UA says "Mac". That is strictly worse than no
 * spoof and is what got an account flagged.
 *
 * Therefore this bundle patches only:
 *   1. navigator.webdriver        → undefined  (Playwright/automation sets true)
 *   2. navigator.permissions.query notifications → "default" (normalize the one
 *      automation-vs-real discrepancy that can leak)
 *   3. Function.prototype.toString → proxied so the single patched function
 *      (`query`) still reports `[native code]` to `.toString()` integrity probes
 *
 * Everything else — WebGL renderer/vendor, navigator.plugins/mimeTypes,
 * languages, hardwareConcurrency, deviceMemory, window.chrome.runtime,
 * Notification.permission, User-Agent, Sec-CH-UA — is left to native Chrome,
 * which reports the true, mutually-consistent values for this machine.
 *
 * MUST be self-contained: this function is serialized via `addInitScript` and
 * runs in page context, so it may not reference any module-scope identifiers.
 */
export const STEALTH_INIT = () => {
  try {
    // Function.prototype.toString — native-shape masking. A detector can probe
    // `someFn.toString().includes("native code")`; re-point toString through a
    // Proxy so our one patched function (and the proxy itself) look native.
    const nativeToString = Function.prototype.toString;
    const toStringMap = new WeakMap();
    const proxiedToString = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        const canned = toStringMap.get(thisArg);
        if (canned) return canned;
        return Reflect.apply(target, thisArg, args);
      },
    });
    Function.prototype.toString = proxiedToString;
    toStringMap.set(proxiedToString, "function toString() { [native code] }");
    const maskNative = (fn, name) => {
      toStringMap.set(fn, `function ${name}() { [native code] }`);
      return fn;
    };

    // navigator.webdriver — the one flag automation actively flips to `true`.
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch { /* ignore */ }

    // navigator.permissions.query — normalize notifications to "default"
    // (real first-visit Chrome) instead of the "denied" automation can surface.
    try {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      const patchedQuery = function query(p) {
        if (p && p.name === "notifications") {
          return Promise.resolve({
            state: "default",
            name: "notifications",
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => true,
          });
        }
        return originalQuery(p);
      };
      navigator.permissions.query = maskNative(patchedQuery, "query");
    } catch { /* ignore */ }
  } catch (err) {
    console.warn("[stealth] init error:", err);
  }
};
