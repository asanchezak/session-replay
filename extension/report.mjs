/**
 * Final report after a test cycle. Pulls applicants on a given Odoo job
 * (and optionally over a recent time window) and prints:
 *   - applicant id, name, LinkedIn URL
 *   - Easy Recruit score + status
 *   - extracted skills (linked in ak_applicant_skill)
 *   - dashboard URL for the originating session-replay run
 *
 * Run:
 *   node report.mjs <job_id>            # all LinkedIn applicants on that job
 *   node report.mjs <job_id> <since>    # since = ISO date "2026-05-27T10:00"
 */
import pgPromise from "pg-promise";
const pgp = pgPromise();

const JOB_ID = Number(process.argv[2] || 22);
const SINCE = process.argv[3] || null;

const db = pgp({
  host: "localhost", port: 5432, database: "morsoft",
  user: "odoo", password: "odoopwd",
});

const filters = [`job_id = $1`, `linkedin LIKE 'https://www.linkedin.com/in/%'`];
const params = [JOB_ID];
if (SINCE) { filters.push(`create_date >= $${params.length + 1}`); params.push(SINCE); }
const where = filters.join(" AND ");

const applicants = await db.any(
  `SELECT id, partner_name, linkedin, job_id, easy_recruit_status,
          job_fit_score, level, responsibility_level,
          create_date, easy_recruit_profile_id, about_you
     FROM hr_applicant
    WHERE ${where}
    ORDER BY id DESC`,
  params,
);

console.log(`\n# Easy Recruit report — job ${JOB_ID}` + (SINCE ? ` since ${SINCE}` : ""));
console.log(`Found ${applicants.length} LinkedIn-sourced applicants.\n`);

for (const a of applicants) {
  console.log("─".repeat(70));
  console.log(`Applicant #${a.id}  ${a.partner_name}`);
  console.log(`  LinkedIn:  ${a.linkedin}`);
  console.log(`  Status:    ${a.easy_recruit_status || "(not analyzed)"}`);
  console.log(`  Fit score: ${a.job_fit_score}/100 (hr_applicant column — see results for AI breakdown)`);
  if (a.level) console.log(`  Level:     ${a.level}`);

  // Linked skills (hr_skill via ak_applicant_skill)
  const skills = await db.any(
    `SELECT hs.name FROM ak_applicant_skill aas JOIN hr_skill hs ON hs.id=aas.skill_id WHERE aas.applicant_id=$1`,
    [a.id],
  );
  if (skills.length) console.log(`  Skills linked (${skills.length}):  ${skills.map((s) => s.name).join(", ")}`);

  // Easy Recruit profile JSON: pull the dimensional score breakdown if present.
  if (a.easy_recruit_profile_id) {
    const prof = await db.oneOrNone(
      `SELECT status, error, results::jsonb AS results FROM concierge_easy_recruit_profile WHERE id=$1`,
      [a.easy_recruit_profile_id],
    );
    if (prof) {
      console.log(`  ER profile: ${a.easy_recruit_profile_id}  status=${prof.status}` + (prof.error ? `  err=${prof.error}` : ""));
      const r = prof.results || {};
      const fit = r.job_fit_score || {};
      if (fit.overall_score !== undefined) {
        console.log(`  AI fit:    ${fit.overall_score}/10   ${fit.recommendation || ""}`);
        const dims = fit.dimension_scores || [];
        dims.forEach((d) => console.log(`    - ${d.dimension}: ${d.score}/10`));
      }
      if (r.specialization?.area_of_specialization) console.log(`  Specialization: ${r.specialization.area_of_specialization}`);
      if (r.english?.english_level) console.log(`  English: ${r.english.english_level}`);
      const yearsAll = (r.experience?.experiences || []).reduce((acc, e) => acc + (e.years || 0), 0);
      if (yearsAll) console.log(`  Total experience: ${yearsAll.toFixed(1)} years`);
      const skillsAI = r.skills?.skills || r.skills?.technologies || [];
      if (Array.isArray(skillsAI) && skillsAI.length) {
        const names = skillsAI.slice(0, 12).map((s) => (typeof s === "string" ? s : s.skill || s.name)).filter(Boolean);
        if (names.length) console.log(`  AI skills (top 12): ${names.join(", ")}`);
      }
    }
  }

  console.log(`  Odoo:     http://localhost:8070/odoo/recruitment/${a.job_id}/${a.id}`);
}

console.log("\n─".repeat(70));
console.log(`Dashboard runs list: http://localhost:5173/runs`);
console.log("");
pgp.end();
