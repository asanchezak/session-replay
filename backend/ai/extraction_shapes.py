"""Single source of truth for per-field extraction shapes.

The Analyze-Page flow suggests fields like ``about``, ``experience``,
``skills`` etc. Each field has a natural output shape: ``about`` is a
single string, ``experience`` is a list of role records, ``skills`` is a
flat list of strings, and so on. This module captures those shapes so the
AI prompt, the workflow analyze-page endpoint, and the run-time extraction
all read from the same definition. Unknown fields fall back to ``unknown``
so the AI can pick the most natural shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

FieldKind = Literal["scalar", "string_list", "record_list", "unknown"]


@dataclass(frozen=True)
class FieldShape:
    kind: FieldKind
    item_keys: tuple[str, ...] | None = None
    extract_hints: str | None = None


FIELD_SHAPES: dict[str, FieldShape] = {
    "about": FieldShape("scalar"),
    "experience": FieldShape(
        "record_list",
        ("title", "company", "location", "dates", "description"),
    ),
    "education": FieldShape(
        "record_list",
        ("school", "degree", "field", "dates"),
        "Extract one record per education entry. Preserve school, degree, field, and dates verbatim when present.",
    ),
    "skills": FieldShape(
        "string_list",
        extract_hints="Extract skill names only. Skip filter tabs, endorsements counts, and company/job context.",
    ),
    "top_skills": FieldShape(
        "string_list",
        extract_hints="Extract only the skill names shown as top skills.",
    ),
    "certifications": FieldShape(
        "record_list",
        ("name", "issuer", "issued"),
        "Extract certification name, issuer, and issued date. Ignore CTA labels and credential-share controls.",
    ),
    "projects": FieldShape(
        "record_list",
        ("name", "description", "dates"),
        "Extract project name, dates, and summary. Ignore surrounding navigation text.",
    ),
    "languages": FieldShape(
        "string_list",
        extract_hints="Extract language names only. Skip proficiency badges unless they are part of the visible label.",
    ),
    "courses": FieldShape(
        "string_list",
        extract_hints="Extract course names only.",
    ),
}


def get_field_shape(key: str) -> FieldShape:
    """Return the registered shape for ``key`` or ``unknown`` if absent."""
    return FIELD_SHAPES.get(key.lower(), FieldShape("unknown"))


def shape_to_dict(shape: FieldShape) -> dict[str, object]:
    """Serialize a FieldShape for transport (analyze-page response, step methods)."""
    return {
        "kind": shape.kind,
        "item_keys": list(shape.item_keys) if shape.item_keys else None,
        "extract_hints": shape.extract_hints,
    }


def normalize_field_key(label: str) -> str:
    """Convert a user-facing label ("Top Skills") to a registry key ("top_skills")."""
    return label.strip().lower().replace("&", "and").replace(" ", "_").replace("-", "_")
