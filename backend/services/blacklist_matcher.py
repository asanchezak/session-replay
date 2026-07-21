"""Blacklist matching for the Recruiter pipeline.

A person on the blacklist must never be sourced, saved to a project, or messaged.
The blacklist lives in Odoo as an `is_blacklisted` flag on `linkedin.candidate`
(the global, cross-position candidate). The backend fetches it once per run and
uses this matcher to (a) pre-filter candidates before they become `linkedin.lead`
rows and (b) drive the post-add sweep that archives blacklisted people who still
land in a project via the bulk results-page save.

Matching is NAME-first: the search extractor yields `/talent/profile/<urn>` URLs
whose URN families (AEMAA… vs ACoAA…) don't unify and don't map to the public
`/in/<slug>/` form, so a URL match rarely fires at discovery time — the normalized
name is the workhorse (name-only auto-removal is an accepted product decision).

CONTRACT — `normalize_name()` here MUST stay byte-identical to akcr
`linkedin.candidate._normalize_name` (same repo family, same Python). The matcher
trusts Odoo's stored `normalized_name` as the source of truth and adds a locally
re-normalized fallback purely as a hedge against the two implementations drifting.
"""
from __future__ import annotations

import unicodedata

from services.profile_url_utils import canonical_profile_url

# Synthetic profile_url prefix Odoo assigns to name-only manual blacklist entries
# (blacklist://name/<normalized_name>). These are NOT real LinkedIn links and must
# never enter the URL match set.
_SYNTHETIC_URL_PREFIX = "blacklist://"


def normalize_name(name: str | None) -> str:
    """Case/accent-fold a display name for matching.

    Steps (order matters — this is the shared contract with akcr):
      1. NFKD decompose, then drop combining marks (José → Jose, Müller → Muller).
      2. casefold (Unicode-correct lowering; handles ß etc.).
      3. Replace every non-alphanumeric character with a space (folds punctuation,
         apostrophes, hyphens, periods; `str.isalnum` is Unicode-aware so non-Latin
         letters/digits survive).
      4. Collapse runs of whitespace and strip.
    """
    if not name:
        return ""
    s = unicodedata.normalize("NFKD", name)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.casefold()
    s = "".join(ch if ch.isalnum() else " " for ch in s)
    return " ".join(s.split())


class BlacklistMatcher:
    """Immutable name/URL lookup built once from the fetched blacklist entries.

    Each entry is a dict {name, normalized_name, profile_url, synthetic?} as
    returned by akcr `/akcr/api/lead_blacklist`. Falsy (empty blacklist) so callers
    can cheaply skip all blacklist work with `if matcher:`.
    """

    def __init__(self, entries: list[dict] | None):
        self._names: set[str] = set()
        self._urls: set[str] = set()
        for entry in entries or []:
            if not isinstance(entry, dict):
                continue
            # Odoo's normalized_name is authoritative — keep it verbatim.
            odoo_norm = (entry.get("normalized_name") or "").strip()
            if odoo_norm:
                self._names.add(odoo_norm)
            # Local re-normalization as a drift hedge (and for entries that predate
            # the stored field).
            local_norm = normalize_name(entry.get("name"))
            if local_norm:
                self._names.add(local_norm)
            url = (entry.get("profile_url") or "").strip()
            if url and not url.startswith(_SYNTHETIC_URL_PREFIX):
                self._urls.add(canonical_profile_url(url).casefold())

    def is_blacklisted(
        self, name: str | None, profile_url: str | None = None
    ) -> tuple[bool, str]:
        """Return (blacklisted, reason) where reason is "url", "name", or ""."""
        if profile_url:
            cu = canonical_profile_url(profile_url).casefold()
            if cu and cu in self._urls:
                return True, "url"
        n = normalize_name(name)
        if n and n in self._names:
            return True, "name"
        return False, ""

    def __len__(self) -> int:
        return len(self._names) + len(self._urls)

    def __bool__(self) -> bool:
        return bool(self._names or self._urls)
