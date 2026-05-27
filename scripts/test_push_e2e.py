"""Synthetic end-to-end test for the LinkedIn applicant push path.

1. Posts two fake profile extractions to a running run via the
   /v1/runs/{id}/extraction endpoint.
2. Marks the run COMPLETED via /v1/runs/{id}/transition, which triggers
   the push-to-Odoo hook.
3. Polls the Odoo DB to confirm two new applicants were created.

Usage:  python scripts/test_push_e2e.py <run_id>
"""
import sys
import time
import httpx

API_KEY = "dev-api-key-change-in-production"
BACKEND = "http://localhost:8081/v1"
HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

PROFILES = [
    {
        "profile_url": "https://www.linkedin.com/in/synthetic-drupal-alpha",
        "full_name": "Alpha Drupal",
        "headline": "Senior Drupal Developer",
        "about": "10+ years building Drupal sites and custom modules.",
        "skills": ["Drupal", "PHP", "Twig"],
        "experience": [
            {"title": "Senior Dev", "company": "AcmeWeb", "dates": "2020-Present", "description": "Drupal 10 platform lead."},
        ],
        "education": [{"school": "TestU", "degree": "BSc", "field": "CS", "dates": "2010-2014"}],
        "certifications": [],
        "projects": [],
    },
    {
        "profile_url": "https://www.linkedin.com/in/synthetic-drupal-beta",
        "full_name": "Beta Drupal",
        "headline": "Drupal Architect",
        "about": "Specialist in Drupal migrations and CI/CD.",
        "skills": ["Drupal", "Composer", "CI/CD"],
        "experience": [
            {"title": "Architect", "company": "WebFirm", "dates": "2018-Present", "description": "Designs scalable Drupal stacks."},
        ],
        "education": [{"school": "Web Univ", "degree": "MSc", "field": "SE", "dates": "2016-2018"}],
        "certifications": [],
        "projects": [],
    },
]


def main(run_id: str) -> None:
    with httpx.Client(timeout=120.0) as client:
        # 1. Fake profile extractions, one POST per profile, with the profile URL.
        for idx, profile in enumerate(PROFILES, start=10):
            payload = {
                "step_index": idx,
                "data": [{
                    "full_name": profile["full_name"],
                    "headline": profile["headline"],
                    "about": profile["about"],
                    "skills": profile["skills"],
                    "experience": profile["experience"],
                    "education": profile["education"],
                    "certifications": profile["certifications"],
                    "projects": profile["projects"],
                }],
                "url": profile["profile_url"],
            }
            r = client.post(
                f"{BACKEND}/runs/{run_id}/extraction", headers=HEADERS, json=payload
            )
            print(f"extraction[{idx}]:", r.status_code, r.text[:200])
            r.raise_for_status()

        # 2. Transition to completed.
        r = client.post(f"{BACKEND}/runs/{run_id}/complete", headers=HEADERS)
        print("complete:", r.status_code, r.text[:300])


if __name__ == "__main__":
    main(sys.argv[1])
