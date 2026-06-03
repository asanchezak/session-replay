/**
 * Shared "automation running" overlay, injected into the daemon's pages via
 * Playwright `addInitScript`. Mirrors the extension's content-script overlay
 * (src/content/index.ts OVERLAY_STYLES / showRunningOverlay) so a person watching
 * the daemon's headed Chrome sees a clear "don't interact" indicator.
 *
 * MUST be self-contained (serialized + run in the page; no outer refs/imports).
 * `pointer-events: none` on everything → purely visual; it does NOT block the
 * daemon's own Playwright/CDP clicks (and wouldn't block a human either — same as
 * the extension overlay). Runs on every document (addInitScript) so it survives
 * navigations; the daemon calls window.__sr_overlay__.hide()/show() to drop it
 * during screenshots (so page_capture shows the real page, not the overlay).
 */
export const OVERLAY_INIT = () => {
  const STYLES = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }
    .sr-overlay-backdrop {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      display: flex; align-items: center; justify-content: center;
      pointer-events: none;
    }
    .sr-overlay-card {
      background: #1A1D27; color: #E8EAED;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 13px; padding: 16px 20px; border-radius: 12px;
      border: 1px solid #2D3148; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      min-width: 280px; max-width: 380px;
      pointer-events: none;
    }
    .sr-overlay-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 600; font-size: 14px; }
    .sr-overlay-dot { width: 8px; height: 8px; border-radius: 50%; background: #6C5CE7; animation: sr-pulse 1.4s ease-in-out infinite; }
    @keyframes sr-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.85); } }
    .sr-overlay-name { font-size: 12px; color: #9AA0B0; margin-bottom: 8px; }
    .sr-overlay-step { color: #74B9FF; font-size: 12px; margin-bottom: 8px; }
    .sr-overlay-progress { height: 3px; background: #2A2E3D; border-radius: 2px; overflow: hidden; }
    .sr-overlay-bar { height: 100%; background: #6C5CE7; border-radius: 2px; transition: width 0.3s ease; }
    .sr-overlay-action { font-size: 11px; color: #9AA0B0; margin-top: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  `;

  function build() {
    if (document.getElementById("sr-running-overlay")) return;
    const root = document.documentElement || document.body;
    if (!root) return;
    const host = document.createElement("div");
    host.id = "sr-running-overlay";
    root.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" + STYLES + "</style>" +
      '<div class="sr-overlay-backdrop"><div class="sr-overlay-card">' +
      '<div class="sr-overlay-header"><span class="sr-overlay-dot"></span>Automatización en curso</div>' +
      '<div class="sr-overlay-name"></div>' +
      '<div class="sr-overlay-step"></div>' +
      '<div class="sr-overlay-progress"><div class="sr-overlay-bar"></div></div>' +
      '<div class="sr-overlay-action"></div>' +
      "</div></div>";
    host.__srShadow = shadow;
  }
  function getShadow() {
    const host = document.getElementById("sr-running-overlay");
    return host ? host.__srShadow : null;
  }

  window.__sr_overlay__ = {
    show(step, total, action, name) {
      build();
      const s = getShadow();
      if (!s) return;
      const set = (sel, txt) => { const el = s.querySelector(sel); if (el != null) el.textContent = txt; };
      if (name) set(".sr-overlay-name", name);
      if (total > 0) {
        set(".sr-overlay-step", "Paso " + (step + 1) + " de " + total);
        const bar = s.querySelector(".sr-overlay-bar");
        if (bar) bar.style.width = Math.round(((step + 1) / total) * 100) + "%";
      }
      if (action) set(".sr-overlay-action", action);
    },
    hide() {
      const host = document.getElementById("sr-running-overlay");
      if (host && host.parentNode) host.parentNode.removeChild(host);
    },
  };

  // Auto-show a default overlay on every document load so it persists across the
  // daemon's navigations (addInitScript re-runs per document).
  const auto = () => {
    try { window.__sr_overlay__.show(0, 0, "", "Automatización en curso — no interactúes"); } catch (e) { /* ignore */ }
  };
  if (document.documentElement) auto();
  else document.addEventListener("DOMContentLoaded", auto, { once: true });
};
