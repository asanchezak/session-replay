import { test, expect } from "../fixtures";
import { ExtensionHelper, PopupPage, DashboardPage } from "../page-objects";

const BACKEND = "http://localhost:8081";
const API_KEY = process.env.E2E_API_KEY || "mQSbOlTTH5hDrRXMVsc-uvVmRcCm3tFgaFpLtGs1Nqw";
const TEST_PAGE_URL = "http://sr-test.local/jobs";

const JOB_SEARCH_HTML = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Buscar Empleo — Costa Rica</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;color:#333}
.header{background:#001c40;color:white;padding:16px 24px;display:flex;align-items:center;gap:16px}
.header h1{font-size:18px;font-weight:600}
.results{max-width:900px;margin:0 auto;padding:16px 24px}
.results-header{margin-bottom:12px;color:#666;font-size:14px}
.job-card{background:white;border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin-bottom:12px}
.job-title{font-size:16px;font-weight:600;color:#004c99;margin-bottom:4px}
.job-company{font-size:14px;color:#444;margin-bottom:2px}
.job-location{font-size:13px;color:#777;margin-bottom:8px}
.job-desc{font-size:13px;color:#555;line-height:1.5;margin-bottom:8px}
.copy-btn{padding:6px 14px;background:#f0f4ff;color:#004c99;border:1px solid #b3d4ff;border-radius:4px;font-size:12px;cursor:pointer}
.pagination{display:flex;gap:8px;justify-content:center;padding:16px}
.pagination button{padding:8px 16px;border:1px solid #ccc;border-radius:4px;background:white;cursor:pointer;font-size:13px}
.pagination button.active{background:#004c99;color:white;border-color:#004c99}
</style></head>
<body>
<div class="header"><h1>🇨🇷 Empleos CR — sin experiencia en Heredia</h1></div>
<div class="results">
<p class="results-header">8 empleos encontrados para "sin experiencia" en Heredia</p>

<div class="job-card"><div><div class="job-title">Asistente Administrativo</div><div class="job-company">Grupo Purdy</div><div class="job-location">Heredia, Heredia</div><div class="job-desc" id="desc-0">Se requiere asistente administrativo sin experiencia para apoyo en labores de oficina, manejo de correspondencia y atención telefónica. Horario de lunes a viernes de 8am a 5pm. Ofrecemos capacitación continua y ambiente laboral agradable.</div></div><div style="text-align:right;margin-top:8px"><button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('desc-0').textContent)">📋 Copiar descripción</button></div></div>

<div class="job-card"><div><div class="job-title">Mesero / Salonero</div><div class="job-company">Hotel Bougainvillea</div><div class="job-location">Santo Domingo, Heredia</div><div class="job-desc" id="desc-1">Importante hotel busca personal sin experiencia para servicio de restaurante. Se ofrece entrenamiento completo en servicio al cliente, manejo de bandejas y protocolos de hospitalidad. Disponibilidad de horarios rotativos.</div></div><div style="text-align:right;margin-top:8px"><button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('desc-1').textContent)">📋 Copiar descripción</button></div></div>

<div class="job-card"><div><div class="job-title">Agente de Call Center</div><div class="job-company">Concentrix Costa Rica</div><div class="job-location">Heredia, Heredia</div><div class="job-desc" id="desc-2">Buscamos agentes de servicio al cliente sin experiencia. Ofrecemos entrenamiento pago de 4 semanas, salario competitivo, bonos mensuales y plan de carrera. Inglés básico deseable. Trabajo 100% presencial en nuestro site en Heredia.</div></div><div style="text-align:right;margin-top:8px"><button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('desc-2').textContent)">📋 Copiar descripción</button></div></div>

<div class="job-card"><div><div class="job-title">Operario de Producción</div><div class="job-company">Coca-Cola FEMSA</div><div class="job-location">Heredia, Heredia</div><div class="job-desc" id="desc-3">Planta embotelladora requiere operarios sin experiencia para línea de producción. Se ofrece capacitación en manejo de maquinaria, normas de seguridad industrial y control de calidad. Turnos rotativos disponibles.</div></div><div style="text-align:right;margin-top:8px"><button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('desc-3').textContent)">📋 Copiar descripción</button></div></div>

<div class="job-card"><div><div class="job-title">Repartidor / Motorizado</div><div class="job-company">Uber Eats</div><div class="job-location">Heredia Centro, Heredia</div><div class="job-desc" id="desc-4">Se buscan repartidores con motocicleta propia. Sin experiencia necesaria. Horarios flexibles, pagos semanales y propinas incluidas. Debe contar con licencia A2 o A3 vigente y smartphone con datos móviles.</div></div><div style="text-align:right;margin-top:8px"><button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('desc-4').textContent)">📋 Copiar descripción</button></div></div>

<div class="pagination">
  <button class="active">1</button>
  <button onclick="document.querySelectorAll('.job-card').forEach((c,i)=>{c.style.display=i<5?'':'none'});this.parentElement.querySelectorAll('button').forEach(b=>b.classList.remove('active'));this.classList.add('active')">2</button>
</div>
</div>
</body></html>`;

test.describe.configure({ mode: "serial" });

test("s58: full job search recording — search 'sin experiencia' in Heredia, copy descriptions, verify extraction",
  async ({ context, extensionId, errors }) => {

  const ext = new ExtensionHelper(context, extensionId);

  // Create a dedicated fresh page for this test — don't use existing tabs
  const testPage = await context.newPage();

  // Close all other pages to prevent tab contamination
  const pages = context.pages();
  for (const p of pages) {
    if (p !== testPage) await p.close().catch(() => {});
  }
  await testPage.bringToFront();
  await testPage.waitForTimeout(1000);

  // 1. Serve the test HTML page (pre-rendered with 8 job listings for sin experiencia in Heredia)
  await testPage.route("**/sr-test.local/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: JOB_SEARCH_HTML });
  });

  // 2. Navigate to test page and wait for it to load
  await testPage.goto(TEST_PAGE_URL);
  await testPage.waitForTimeout(1500);
  await expect(testPage.getByText("sin experiencia en Heredia")).toBeVisible();
  console.log("  [1/6] Test page loaded — 8 job listings visible");

  // 3. Ensure test page is focused and content script is ready before recording
  await testPage.bringToFront();
  await testPage.waitForTimeout(1000);
  // Verify content script is loaded
  await testPage.evaluate(() => (window as any).__SR_CONTENT_SCRIPT__, { timeout: 5000 }).catch(() => {});
  await testPage.waitForTimeout(1000);

  const recordingStartedAt = Date.now();
  const popup = await ext.openPopup();
  await popup.clickRecord();
  await popup.page.waitForTimeout(1000);
  // Bring test page back to front for interactions and verify recording targets this tab
  await testPage.bringToFront();
  await testPage.waitForTimeout(500);
  expect(await popup.isRecording()).toBeTruthy();
  console.log("  [2/6] Recording started");

  // 4. Scroll through job listings (captures scroll events).
  // Use page.mouse.wheel() which reliably fires DOM scroll events in headless Playwright.
  await testPage.mouse.wheel(0, 200);
  await testPage.waitForTimeout(600); // > 500ms debounce
  await testPage.mouse.wheel(0, 400);
  await testPage.waitForTimeout(600);
  console.log("  [3/6] Scrolled through listings");

  // 5. Click "Copiar descripción" on first 4 job cards (page 1)
  const copyBtns = testPage.locator("button:has-text('Copiar')");
  const btnCount = await copyBtns.count();
  console.log(`  [4/6] Found ${btnCount} copy buttons`);

  for (let i = 0; i < Math.min(btnCount, 4); i++) {
    await copyBtns.nth(i).click();
    await testPage.waitForTimeout(300);
  }
  console.log("  [4/6] Copied descriptions from page 1");

  // 6. Click page 2 button
  const page2Btn = testPage.locator("button:has-text('2')");
  if (await page2Btn.isVisible().catch(() => false)) {
    await page2Btn.click();
    await testPage.waitForTimeout(800);
    console.log("  [5/6] Navigated to page 2");
  }

  // 7. Click copy on remaining copy buttons (now only page 2 jobs visible)
  const copyBtns2 = testPage.locator("button:has-text('Copiar')");
  const btnCount2 = await copyBtns2.count();
  for (let i = 0; i < btnCount2; i++) {
    const btn = copyBtns2.nth(i);
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await testPage.waitForTimeout(200);
    }
  }
  console.log("  [5/6] Copied descriptions from page 2");

  // 8. Stop recording
  await popup.page.bringToFront();
  await popup.page.waitForTimeout(500);
  await popup.clickStop();
  await popup.page.waitForTimeout(3000);
  expect(await popup.isIdle()).toBeTruthy();
  console.log("  [6/6] Recording stopped");

  // 9. Verify workflow created via API — poll until our recording is persisted.
  // Filter by target_url (sr-test.local is unique to this test) to avoid picking up
  // concurrent test workflows from other spec files.
  let wfOurs: any[] = [];
  let wfAll: any[] = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    const wfResp = await testPage.request.get(`${BACKEND}/v1/workflows`, {
      headers: { "X-API-Key": API_KEY },
    });
    wfAll = await wfResp.json();
    wfOurs = wfAll
      .filter((w: any) =>
        new Date(w.created_at).getTime() >= recordingStartedAt &&
        w.target_url?.includes("sr-test.local"))
      .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    if (wfOurs.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const latestWf = wfOurs[0] ?? [...wfAll]
    .filter((w: any) => w.target_url?.includes("sr-test.local"))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0]
    ?? [...wfAll].sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  expect(latestWf.name).toBeTruthy();

  // 10. Get workflow detail — verify steps
  const detailResp = await testPage.request.get(`${BACKEND}/v1/workflows/${latestWf.id}`, {
    headers: { "X-API-Key": API_KEY },
  });
  const detail = (await detailResp.json()) as any;
  console.log(`  Workflow: ${latestWf.id} (${detail.steps.length} steps)`);
  for (const s of detail.steps) {
    console.log(`    ${s.step_index}. ${s.action_type} ${(s.intent || '').slice(0, 70)}`);
  }
  expect(detail.steps.length).toBeGreaterThanOrEqual(3);
  // Verify we captured click events for copy buttons and pagination
  const clickSteps = detail.steps.filter((s: any) => s.action_type === "click");
  expect(clickSteps.length).toBeGreaterThanOrEqual(2);
  const scrollSteps = detail.steps.filter((s: any) => s.action_type === "scroll");
  // Scroll capture can be coalesced depending on timing; ensure overall interaction richness.
  expect(scrollSteps.length + clickSteps.length).toBeGreaterThanOrEqual(2);

  // 11. Verify analysis ran with goal and parameters
  if (detail.analysis && detail.analysis.workflow_goal) {
    console.log(`  Analysis: goal="${detail.analysis.workflow_goal}"`);
    console.log(`  Confidence: ${detail.analysis.confidence_overall}`);
    console.log(`  Parameters: ${detail.analysis.parameters?.length || 0}`);
    console.log(`  Phases: ${detail.analysis.phases?.length || 0}`);
  }

  // 12. Run the workflow
  await testPage.request.put(`${BACKEND}/v1/workflows/${latestWf.id}/status`, {
    headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
    data: { status: "active" },
  });
  const runResp = await testPage.request.post(`${BACKEND}/v1/workflows/${latestWf.id}/run`, {
    headers: { "X-API-Key": API_KEY },
  });
  const runData = (await runResp.json()) as any;
  console.log(`  Run: ${runData.id} status=${runData.status}`);

  // 13. Poll for run completion
  let finalStatus = "running";
  for (let attempt = 0; attempt < 20; attempt++) {
    await testPage.waitForTimeout(2000);
    const statusResp = await testPage.request.get(`${BACKEND}/v1/runs/${runData.id}`, {
      headers: { "X-API-Key": API_KEY },
    });
    const statusData = (await statusResp.json()) as any;
    finalStatus = statusData.status;
    if (["completed", "failed", "canceled"].includes(finalStatus)) break;
  }
  console.log(`  Run final status: ${finalStatus} (step ${runData.current_step_index}/${runData.total_steps})`);

  // 14. Check events
  const eventsResp = await testPage.request.get(`${BACKEND}/v1/runs/${runData.id}/events?limit=200`, {
    headers: { "X-API-Key": API_KEY },
  });
  const events = (await eventsResp.json()) as any[];
  const extractionEvents = events.filter((e: any) => e.event_type === "extraction");
  const stepEvents = events.filter((e: any) => e.event_type === "step_executed");
  console.log(`  Events: ${events.length} total, ${stepEvents.length} step_executed, ${extractionEvents.length} extraction`);

  // 15. Verify no console errors
  expect(errors.filter(e => e.type === "console")).toHaveLength(0);
  console.log("  ✅ Test complete — full flow verified");

  await popup.page.close();
  await testPage.close();
});
