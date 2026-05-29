/**
 * PoC parte 2: ¿la sesión de usuario en segundo plano conserva la GPU de hardware?
 *
 * Acompaña a test-bg-session-chrome.mjs. Lanza Chrome HEADED igual que el daemon
 * (channel:"chrome", headless:false) y lee el UNMASKED_RENDERER_WEBGL N veces:
 *   - HARDWARE: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 ...)" / "Apple GPU"
 *   - SOFTWARE: "SwiftShader" / "llvmpipe" / "Software"  → CONTRADICCIÓN de fingerprint
 *
 * Una M1 real que renderiza por software es justo el tell que marcó la cuenta el
 * 2026-05-28. Si en 2º plano sigue siendo Apple en las N lecturas → headed-in-bg
 * es seguro por fingerprint. Si aparece SwiftShader → fallback (Mac dedicada).
 *
 * CORRER desde extension/ (playwright instalado ahí). Perfil temp aislado +
 * about:blank — cero LinkedIn. Env: ITERATIONS (10), INTERVAL_MS (3000).
 *   node test-bg-session-gpu.mjs
 */
import { chromium } from "playwright";
import os from "os";
import path from "path";
import fs from "fs";

const ITERATIONS = Number(process.env.ITERATIONS || "10");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || "3000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOFTWARE_RE = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;
const HARDWARE_RE = /apple|metal|\bm[1-9]\b/i;

const readGL = () => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
  if (!gl) return { error: "no webgl context" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    hasDebugExt: !!dbg,
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
  };
};

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-check-"));
console.log(`[gpu] launching HEADED Chrome (temp profile ${profileDir})`);
console.log(`[gpu] reading WebGL renderer ${ITERATIONS}x while (presumably) backgrounded\n`);

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

let hw = 0, sw = 0, unknown = 0;
try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 });
  for (let i = 1; i <= ITERATIONS; i++) {
    const r = await page.evaluate(readGL);
    let verdict;
    if (r.error) { verdict = "NO-WEBGL"; unknown++; }
    else if (SOFTWARE_RE.test(r.renderer || "")) { verdict = "SOFTWARE ✗"; sw++; }
    else if (HARDWARE_RE.test(r.renderer || "")) { verdict = "HARDWARE (Apple) ✓"; hw++; }
    else { verdict = "UNKNOWN ?"; unknown++; }
    console.log(`[gpu] ${i}/${ITERATIONS} · renderer=${JSON.stringify(r.renderer || r.error)} · vendor=${JSON.stringify(r.vendor || "")}${r.hasDebugExt === false ? " · (sin WEBGL_debug_renderer_info!)" : ""} · => ${verdict}`);
    await sleep(INTERVAL_MS);
  }
  console.log("");
  if (sw > 0) {
    console.log(`[gpu] VERDICT: SOFTWARE detectado en ${sw}/${ITERATIONS} lecturas — la sesión backgrounded PERDIÓ la GPU. Headed-in-bg NO es seguro (contradicción de fingerprint). => fallback Mac dedicada / sesión al frente.`);
    process.exitCode = 1;
  } else if (hw === ITERATIONS) {
    console.log(`[gpu] VERDICT: HARDWARE (Apple GPU) en ${hw}/${ITERATIONS} — la GPU real sobrevive el segundo plano. Headed-in-bg ES seguro por fingerprint.`);
  } else {
    console.log(`[gpu] VERDICT: INDETERMINADO (hw=${hw} sw=${sw} unknown=${unknown}). Revisar los renderer strings de arriba a mano.`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`[gpu] FAIL — ${err.message || err}`);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
