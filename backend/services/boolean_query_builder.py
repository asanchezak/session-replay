"""Build a LinkedIn Recruiter BOOLEAN search from a job's content.

Hybrid (the user's choice): an AI agent reads the JD free text and returns a
structured spec; OUR code assembles the boolean string deterministically and
exposes a single "tightness" knob the orchestrator turns to calibrate the result
count (~15). The AI only does the hard part — reading unstructured JD text — and
NEVER decides the query shape or the count.

Surface: the assembled string goes into the advanced-search "Add Profile keywords
or boolean" field. LinkedIn boolean = AND/OR/NOT (caps), quoted phrases,
parentheses; NO wildcards.
"""
from __future__ import annotations

import json
import logging
import re

from ai.client import get_ai_provider

logger = logging.getLogger(__name__)

_SYSTEM = (
    "You are a senior technical sourcer building a LinkedIn Recruiter boolean "
    "search. You output ONLY strict JSON, no prose."
)

_PROMPT = """From this job description, extract search terms for finding matching candidates on LinkedIn.

JOB DESCRIPTION:
{corpus}

Return ONLY this JSON object (no markdown, no comments):
{{
  "title_variants": ["up to 4 job-title strings a matching profile might use, incl. common synonyms/abbreviations"],
  "must_have_skills": [["a REQUIRED capability as a GROUP of 2-5 INTERCHANGEABLE terms — synonyms, equivalent tools, and the umbrella concept — so a candidate matches if they have ANY term in the group. Ordered most→least important, max 6 groups."]],
  "optional_skills": [["nice-to-have capability groups, max 4"]],
  "seniority": "one of: junior, mid, senior, lead, or null",
  "location": "country or region the role targets, or null",
  "years_min": integer or null,
  "years_max": integer or null,
  "exclude": ["titles/terms to NOT match, e.g. \\"Manager\\", \\"Intern\\", max 4"],
  "recommended_tightness": "integer: how many of the above skill GROUPS to REQUIRE (AND together), most-important first. A focused senior/lead role with a distinctive stack → 4-6; a normal mid/senior role → 3-4; a broad/vague/junior role → 2. Never exceed the number of groups you listed."
}}

HOW TO BUILD SKILL GROUPS (this is the important part — do it well):
- Each group represents ONE required capability via DIFFERENT words. A candidate matches the
  group if they have ANY term in it, so DON'T force every exact tool — cluster interchangeable
  ones. E.g. orchestration/streaming → ["Kafka","Airflow","Spark","streaming"]; containers & IaC
  → ["Kubernetes","Docker","Terraform","CloudFormation"]; cloud → ["AWS","GCP","Azure"] (use a
  1-term group like ["AWS"] ONLY if a single cloud is genuinely mandatory).
- Derive capabilities from BOTH the explicit tech stack AND the RESPONSIBILITIES — the role's
  distinctive duties are often the best signal. E.g. a duty "design APIs for ML models / deploy
  ML models" → ["model serving","MLOps","ML API","inference","machine learning"].
- One capability per group; do NOT mix unrelated skills. Prefer specific umbrella terms
  ("model serving","MLOps") over bare generic ones ("API","data","cloud").
- Do NOT create a group that merely restates the job title/role (e.g. a "Data Engineering"
  group for a Data Engineer role) — the title is already searched separately, so spend each
  group on a DISTINCT hard capability/tool instead.

Rules: terms must be concrete searchable tech/tools/role-concepts, NOT soft skills or sentences.
Use the BASE technology name WITHOUT version numbers ("Next.js" not "Next.js 15", "Angular" not
"Angular 2+", "Python" not "Python 3") — a versioned AND term over-narrows to ~0. If the JD is
sparse, infer reasonable groups from the title.
"""

_MAX_TITLES = 4
_MAX_GROUPS = 8        # combined must + optional cap for the AND chain (each AND clause = a group)
_MAX_TERMS_PER_GROUP = 5


def _clean_terms(items, cap):
    out, seen = [], set()
    for x in items or []:
        if not isinstance(x, str):
            continue
        s = x.strip().strip('"').strip()
        # boolean operators / quotes inside a term would break the query
        s = s.replace('"', "").replace("(", " ").replace(")", " ")
        s = re.sub(r"\s+", " ", s).strip()
        # Drop a trailing version number ("Next.js 15"->"Next.js", "Angular 2+"->"Angular",
        # "Python 3"->"Python"). LinkedIn profiles list the base tech, so a versioned AND
        # term over-narrows to ~0. Keep glued names like "HTML5"/"CSS3"/"S3" (no space).
        s = re.sub(r"\s+v?\d+(?:\.\d+)*\+?$", "", s).strip()
        if not s or s.lower() in ("and", "or", "not", "null", "none"):
            continue
        k = s.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append(s)
        if len(out) >= cap:
            break
    return out


def _clean_groups(items, cap_groups):
    """Normalize skills into a list of GROUPS (each a cleaned list of interchangeable terms).
    Tolerates the legacy flat shape (a string item becomes a 1-term group)."""
    out, seen = [], set()
    for grp in items or []:
        if isinstance(grp, str):
            grp = [grp]
        if not isinstance(grp, list):
            continue
        terms = _clean_terms(grp, _MAX_TERMS_PER_GROUP)
        if not terms:
            continue
        key = tuple(sorted(t.lower() for t in terms))
        if key in seen:
            continue
        seen.add(key)
        out.append(terms)
        if len(out) >= cap_groups:
            break
    return out


class BooleanQueryBuilder:
    """Stateless: corpus → spec (AI) → boolean (deterministic). The orchestrator
    keeps the spec + the current tightness in origin.pipeline for re-tuning."""

    async def extract_spec(self, corpus: str, fallback_title: str = "") -> dict:
        corpus = (corpus or "").strip()
        if not corpus:
            corpus = f"Job title: {fallback_title}"
        provider = get_ai_provider()
        try:
            resp = await provider.generate(
                _PROMPT.format(corpus=corpus[:6000]),
                system=_SYSTEM,
                max_tokens=700,
            )
            spec = self._parse(resp.content)
        except Exception:
            logger.exception("boolean builder: AI extract failed — title-only fallback")
            spec = {}
        # Normalize + defaults
        spec["title_variants"] = _clean_terms(spec.get("title_variants"), _MAX_TITLES) or (
            [fallback_title.strip()] if fallback_title.strip() else []
        )
        spec["must_have_skills"] = _clean_groups(spec.get("must_have_skills"), 6)
        spec["optional_skills"] = _clean_groups(spec.get("optional_skills"), 4)
        spec["exclude"] = _clean_terms(spec.get("exclude"), 4)
        spec["seniority"] = (spec.get("seniority") or None)
        spec["location"] = (spec.get("location") or None)
        for k in ("years_min", "years_max", "recommended_tightness"):
            try:
                spec[k] = int(spec[k]) if spec.get(k) not in (None, "", "null") else None
            except (TypeError, ValueError):
                spec[k] = None
        return spec

    @staticmethod
    def _parse(content: str) -> dict:
        if not content:
            return {}
        m = re.search(r"\{.*\}", content, re.S)
        if not m:
            return {}
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            return {}

    def assemble(self, spec: dict, tightness: int) -> str:
        """Boolean = (title OR variants) AND (g1a OR g1b ...) AND (g2a OR ...) ... [NOT (excl)].
        Each AND clause is a GROUP of interchangeable terms (OR'd), so a candidate matches a
        clause with ANY of its terms — much better recall than AND'ing every exact tool.
        `tightness` = how many groups are AND'd (musts first, then optionals); 0 = title-only."""
        titles = [f'"{t}"' for t in spec.get("title_variants", [])]
        groups = (
            list(spec.get("must_have_skills", [])) + list(spec.get("optional_skills", []))
        )[:_MAX_GROUPS]
        t = max(0, min(int(tightness), len(groups)))
        parts: list[str] = []
        if titles:
            parts.append("(" + " OR ".join(titles) + ")")
        for g in groups[:t]:
            if isinstance(g, str):  # tolerate a legacy flat spec
                g = [g]
            terms = [f'"{x}"' for x in g if x]
            if not terms:
                continue
            parts.append(terms[0] if len(terms) == 1 else "(" + " OR ".join(terms) + ")")
        query = " AND ".join(parts) if parts else (titles[0] if titles else "")
        excl = [f'"{e}"' for e in spec.get("exclude", [])][:3]
        if excl and query:
            query += " NOT (" + " OR ".join(excl) + ")"
        return query.strip()

    def max_tightness(self, spec: dict) -> int:
        return min(
            _MAX_GROUPS,
            len(spec.get("must_have_skills", [])) + len(spec.get("optional_skills", [])),
        )

    async def build(self, corpus: str, fallback_title: str = "", start_tightness: int = 2) -> dict:
        """One-shot: corpus → {query, spec, tightness}.

        The AI decides the STRICTNESS via spec.recommended_tightness (how many of its
        own ranked skills to AND). `start_tightness` is an operator FLOOR (minimum
        strictness) — the AI may go stricter but not below it. Both are clamped to the
        number of skills the AI actually returned (max_tightness). Calibration can still
        adjust ±1 from here."""
        spec = await self.extract_spec(corpus, fallback_title)
        mx = self.max_tightness(spec)
        floor = max(0, min(int(start_tightness), mx))
        ai_t = spec.get("recommended_tightness")
        t = floor if ai_t is None else max(floor, min(int(ai_t), mx))
        return {"query": self.assemble(spec, t), "spec": spec, "tightness": t,
                "ai_tightness": ai_t, "tightness_floor": floor}
