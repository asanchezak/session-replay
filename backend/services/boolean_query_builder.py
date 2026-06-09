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
  "must_have_skills": ["the hard skills/technologies REQUIRED, ordered most→least important, max 6, concrete & searchable e.g. \\"React\\", \\"Kubernetes\\", \\"Python\\""],
  "optional_skills": ["nice-to-have hard skills, max 6"],
  "seniority": "one of: junior, mid, senior, lead, or null",
  "location": "country or region the role targets, or null",
  "years_min": integer or null,
  "years_max": integer or null,
  "exclude": ["titles/terms to NOT match, e.g. \\"Manager\\", \\"Intern\\", max 4"]
}}

Rules: skills must be concrete searchable tech/tools, NOT soft skills or sentences.
Prefer specific terms over generic ones. If the JD is sparse, infer reasonable
terms from the title.
"""

_MAX_TITLES = 4
_MAX_SKILLS = 8  # combined must + optional cap for the AND chain


def _clean_terms(items, cap):
    out, seen = [], set()
    for x in items or []:
        if not isinstance(x, str):
            continue
        s = x.strip().strip('"').strip()
        # boolean operators / quotes inside a term would break the query
        s = s.replace('"', "").replace("(", " ").replace(")", " ")
        s = re.sub(r"\s+", " ", s).strip()
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
        spec["must_have_skills"] = _clean_terms(spec.get("must_have_skills"), 6)
        spec["optional_skills"] = _clean_terms(spec.get("optional_skills"), 6)
        spec["exclude"] = _clean_terms(spec.get("exclude"), 4)
        spec["seniority"] = (spec.get("seniority") or None)
        spec["location"] = (spec.get("location") or None)
        for k in ("years_min", "years_max"):
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
        """Boolean = (title OR variants) AND skill1 AND skill2 ... [NOT (excl...)].
        `tightness` = how many skills are AND'd (musts first, then optionals).
        0 = title-only (broadest); higher = tighter."""
        titles = [f'"{t}"' for t in spec.get("title_variants", [])]
        skills = [f'"{s}"' for s in (
            list(spec.get("must_have_skills", [])) + list(spec.get("optional_skills", []))
        )][:_MAX_SKILLS]
        t = max(0, min(int(tightness), len(skills)))
        parts: list[str] = []
        if titles:
            parts.append("(" + " OR ".join(titles) + ")")
        parts.extend(skills[:t])
        query = " AND ".join(parts) if parts else (titles[0] if titles else "")
        excl = [f'"{e}"' for e in spec.get("exclude", [])][:3]
        if excl and query:
            query += " NOT (" + " OR ".join(excl) + ")"
        return query.strip()

    def max_tightness(self, spec: dict) -> int:
        return min(
            _MAX_SKILLS,
            len(spec.get("must_have_skills", [])) + len(spec.get("optional_skills", [])),
        )

    async def build(self, corpus: str, fallback_title: str = "", start_tightness: int = 2) -> dict:
        """One-shot: corpus → {query, spec, tightness}. Start at title + 2 skills."""
        spec = await self.extract_spec(corpus, fallback_title)
        t = max(0, min(start_tightness, self.max_tightness(spec)))
        return {"query": self.assemble(spec, t), "spec": spec, "tightness": t}
