"""Shared canonicalization for LinkedIn / Recruiter profile URLs.

Leads, applicants, and outreach updates all join on the bare profile URL, so
every push service (recruiter / applicant / lead) must canonicalize identically
— drop the ?query (?project=…&trk=…) and #fragment, strip a trailing slash.
See docs/recruiter-odoo-integration-design.md for the keying contract.
"""
from __future__ import annotations

# Public profile prefix shared by the applicant + lead flows.
PROFILE_URL_PREFIX = "linkedin.com/in/"
# Recruiter cards carry /talent/profile/<id>; also accept the public /in/ form.
RECRUITER_PROFILE_MARKERS = ("/talent/profile/", PROFILE_URL_PREFIX)


def canonical_profile_url(url: str) -> str:
    """Canonicalize for dedup/match — drop query + fragment, strip trailing slash."""
    return url.split("?", 1)[0].split("#", 1)[0].rstrip("/")


def is_profile_url(
    url: str | None, markers: tuple[str, ...] = (PROFILE_URL_PREFIX,)
) -> bool:
    """True if `url` (sans query) contains any of the profile-URL markers."""
    if not url:
        return False
    head = url.split("?", 1)[0]
    return any(m in head for m in markers)
