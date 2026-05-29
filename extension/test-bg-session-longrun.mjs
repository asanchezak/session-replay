/**
 * PoC parte 3 (sostenido): ¿headed Chrome en sesión de usuario en 2º plano aguanta
 * >=15 min sin congelarse, sin perder la GPU y sin que el loop se frene (App Nap)?
 *
 * Acompaña a test-bg-session-chrome.mjs (render) y test-bg-session-gpu.mjs (GPU).
 * Cada vuelta: navega example.com, screenshot (render), lee UNMASKED_RENDERER_WEBGL
 * (GPU). Loguea con timestamp y el "gap" real entre vueltas — si el gap se dispara
 * muy por encima del intervalo, macOS está throttleando la sesión backgrounded.
 *
 * CORRER desde extension/, envuelto en caffeinate para que no duerma la Mac:
 *   caffeinate -dimsu node test-bg-session-longrun.mjs
 * Perfil temp aislado + example.com — cero LinkedIn.
 * Env: DURATION_MIN (15), INTERVAL_MS (5000).
 */
import { chromium } from "playwright";
import os from "os";
import path from "path";
import fs from "fs";

const DURATION_MIN = Number(process.env.DURATION_MIN || "15");
const INTERVAL_MS = Number(process.env.INTERVAL_MS || "5000");
const DURATION_MS = DURATION_MIN * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

const SOFTWARE_RE = /swiftshader|llvmpipe|software|basic render/i;
const HARDWARE_RE = /apple|metal|\bm[1-9]\b/i;

const readGL = () => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl");
  if (!gl) return { error: "no webgl" };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
};

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "long-run-"));
console.log(`[long] ${ts()} start · target ${DURATION_MIN} min · interval ${INTERVAL_MS}ms · profile ${profileDir}`);
console.log(`[long] switch to your other user now; this must keep ticking with Apple GPU.\n`);

const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

let iter = 0, hw = 0, sw = 0, err = 0, maxGapMs = 0, maxShot = 0, minShot = Infinity;
const startMs = Date.now();
let lastTick = startMs;

try {
  const page = ctx.pages()[0] || (await ctx.newPage());
  while (Date.now() - startMs < DURATION_MS) {
    iter++;
    let line, anomaly = false;
    try {
      await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
      const shot = (await page.screenshot()).length;
      const gl = await page.evaluate(readGL);
      const r = gl.renderer || gl.error || "";
      maxShot = Math.max(maxShot, shot); minShot = Math.min(minShot, shot);
      let cls;
      if (gl.error) { cls = "NO-WEBGL"; err++; anomaly = true; }
      else if (SOFTWARE_RE.test(r)) { cls = "SOFTWARE✗"; sw++; anomaly = true; }
      else if (HARDWARE_RE.test(r)) { cls = "HW-Apple✓"; hw++; }
      else { cls = "UNKNOWN?"; err++; anomaly = true; }
      const now = Date.now();
      const gap = now - lastTick; lastTick = now;
      maxGapMs = Math.max(maxGapMs, gap);
      const elapsedMin = ((now - startMs) / 60000).toFixed(1);
      line = `[long] ${ts()} #${iter} t=${elapsedMin}m gap=${gap}ms shot=${shot}B gpu=${cls}`;
      if (anomaly) line += ` <-- RENDERER=${JSON.stringify(r)}`;
    } catch (e) {
      err++; anomaly = true;
      const now = Date.now(); const gap = now - lastTick; lastTick = now;
      maxGapMs = Math.max(maxGapMs, gap);
      line = `[long] ${ts()} #${iter} ERROR gap=${gap}ms :: ${e.message || e}`;
    }
    // Loguea cada vuelta el 1er minuto, luego 1 de cada 6 (~cada 30s) + toda anomalía.
    if (anomaly || iter <= 12 || iter % 6 === 0) console.log(line);
    await sleep(INTERVAL_MS);
  }
  const ranMin = ((Date.now() - startMs) / 60000).toFixed(1);
  console.log(`\n[long] ${ts()} === RESUMEN ===`);
  console.log(`[long] duró ${ranMin} min · ${iter} vueltas · HW-Apple=${hw} SOFTWARE=${sw} errores=${err}`);
  console.log(`[long] screenshot bytes: min=${minShot} max=${maxShot} · gap máx entre vueltas=${maxGapMs}ms (intervalo objetivo=${INTERVAL_MS}ms)`);
  if (sw > 0 || err > 0) {
    console.log(`[long] VERDICT: FALLÓ — hubo ${sw} lecturas SOFTWARE y ${err} errores. Headed-in-bg NO es confiable sostenido.`);
    process.exitCode = 1;
  } else if (maxGapMs > INTERVAL_MS * 4) {
    console.log(`[long] VERDICT: OK con THROTTLING — GPU/render perfectos, pero el gap máx (${maxGapMs}ms) sugiere que macOS frenó la sesión en 2º plano. Funciona pero más lento; tenerlo en cuenta para la cadencia.`);
  } else {
    console.log(`[long] VERDICT: PASS — ${ranMin} min en 2º plano, ${hw}/${iter} HW-Apple, render estable, sin throttling notable. Modelo sólido sostenido.`);
  }
} catch (err2) {
  console.error(`[long] FATAL — ${err2.message || err2}`);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
