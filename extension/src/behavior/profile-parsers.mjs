// Pure profile-section parsers, extracted verbatim from driver-daemon.mjs (de-dup
// Phase 1). They transform already-scraped text arrays — produced by the in-page
// DOM extractors — into structured records. ZERO browser/page coupling: no
// `page`, no `document`, no Node APIs. That makes them unit-testable under jsdom
// and shareable across the daemon (Playwright) and any future runtime.
//
// Input shapes:
//   - experience items: { paras: string[], desc?: string }
//   - list items (skills/education/certs/projects/simple): { texts: string[] }

export const DATE_LINE_RE = /\b(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s*\d{4}|(?:Present|Actualidad|Currently|Actualmente)|\b\d{4}\s*-\s*\d{4}\b/i;
export const EMPLOYMENT_TYPE_RE = /\b(?:Full[- ]time|Part[- ]time|Contract|Freelance|Self[- ]employed|Internship|Apprenticeship|Temporary|Volunteer|Jornada completa|Jornada parcial|Contrato|Aut[óo]nomo|Pr[áa]cticas|Trabajo temporal|Voluntariado)\b/i;
export const IGNORED_SECTION_LINES = /^(show all|see all|mostrar todo|ver todo|skills|habilidades|aptitudes|education|educaci[oó]n|formaci[oó]n|licenses?\s*&\s*certifications|licencias y certificaciones|projects|proyectos|courses|cursos|languages|idiomas|all|industry knowledge|tools\s*&\s*technologies|interpersonal skills|other skills|more profiles for you|people you may know|personas que podr[íi]as conocer|conocimientos del sector|herramientas y tecnolog[íi]as|habilidades interpersonales|otras habilidades|·\s*\d+(st|nd|rd|th)?(\s*degree)?|\d+(st|nd|rd|th)?\s*(degree|grado)?\s*connection|conexi[oó]n\s*\d+(º|°)?|endorsed by|recomendado por|verified|verificado|premium|open to work|abierto a oportunidades)$/i;

export function parseExperienceItems(items) {
  const out = [];
  for (const it of items) {
    const paras = it.paras || [];
    if (!paras.length) continue;
    const title = paras[0] || "";
    let dates = "", employment_type = "", company = "";
    for (let i = 1; i < paras.length; i++) {
      const t = paras[i];
      if (!dates && DATE_LINE_RE.test(t)) dates = t;
      else if (!employment_type && EMPLOYMENT_TYPE_RE.test(t)) employment_type = t;
      else if (!company) company = t;
    }
    out.push({ title, company, employment_type, dates, duration: "", location: "", description: (it.desc || "").slice(0, 1500) });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseSkillItems(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const name = (item.texts || []).find((text) => !IGNORED_SECTION_LINES.test(text) && text.length <= 80);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

export function parseEducationItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const school = texts[0] || "";
    if (!school) continue;
    let degree = "";
    let field = "";
    let dates = "";
    for (const text of texts.slice(1)) {
      if (!dates && DATE_LINE_RE.test(text)) {
        dates = text;
        continue;
      }
      if (!degree) {
        degree = text;
        continue;
      }
      if (!field) field = text;
    }
    out.push({ school, degree, field, dates });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseCertificationItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const name = texts[0] || "";
    if (!name) continue;
    let issuer = "";
    let issued = "";
    for (const text of texts.slice(1)) {
      if (!issued && DATE_LINE_RE.test(text)) {
        issued = text;
        continue;
      }
      if (!issuer) issuer = text;
    }
    out.push({ name, issuer, issued });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseProjectItems(items) {
  const out = [];
  for (const item of items) {
    const texts = (item.texts || []).filter((text) => !IGNORED_SECTION_LINES.test(text));
    if (!texts.length) continue;
    const name = texts[0] || "";
    if (!name) continue;
    let dates = "";
    const descParts = [];
    for (const text of texts.slice(1)) {
      if (!dates && DATE_LINE_RE.test(text)) {
        dates = text;
        continue;
      }
      descParts.push(text);
    }
    out.push({ name, dates, description: descParts.join(" ").slice(0, 1500) });
    if (out.length >= 12) break;
  }
  return out;
}

export function parseSimpleListItems(items, limit = 25) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const value = (item.texts || []).find((text) => !IGNORED_SECTION_LINES.test(text));
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}
