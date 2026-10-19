"""Does a candidate's displayed location fall inside a position's geography?

The Python twin of recruiter.mjs's parseLocationSpec / normalizeLocationText /
locationAllowed — keep the two in step (extension/tests/location-facet.test.mjs pins
the JS side, tests/unit/test_recruiter_geography.py this one).

A spec is one string: places separated by ";", spellings of the same place by "|".
LinkedIn writes locations most-specific-first and ending on the country ("Escazú, San
José, Costa Rica"), so a place only counts at the END of the displayed location —
"Panama" must not admit "Panama City, Florida, United States", and "San José, Costa
Rica" admits its districts but not "Costa Rica" alone.
"""
import re
import unicodedata

_PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")


def spec_terms(spec) -> list[str]:
    """Every accepted spelling in a spec, flat. Blank or an unresolved "{{…}}"
    placeholder means no geography at all."""
    s = str(spec or "").strip()
    if not s or _PLACEHOLDER.search(s):
        return []
    return [t.strip() for entry in s.split(";") for t in entry.split("|") if t.strip()]


def normalize(text) -> str:
    """Accent/case/punctuation-insensitive: "São Paulo, Brasil" → "sao paulo brasil"."""
    s = unicodedata.normalize("NFD", str(text or ""))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def location_allowed(location, terms) -> bool:
    """No terms ⇒ no filter (everything passes). An unreadable location ⇒ NOT allowed
    (fail closed)."""
    wanted = [n for n in (normalize(t) for t in (terms or [])) if n]
    if not wanted:
        return True
    hay = normalize(location)
    if not hay:
        return False
    return any(hay == t or hay.endswith(f" {t}") for t in wanted)
