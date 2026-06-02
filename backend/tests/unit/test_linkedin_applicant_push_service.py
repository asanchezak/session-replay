from services.linkedin_applicant_push_service import _build_pre_extracted


def test_build_pre_extracted_keeps_only_canonical_non_empty_fields():
    profile = {
        "profile_url": "https://www.linkedin.com/in/test-person",
        "full_name": "Test Person",
        "headline": "Engineer",
        "about": "",
        "skills": ["Python"],
        "experience": [],
        "education": [{"school": "UTN"}],
        "courses": ["ML Ops"],
        "languages": ["English"],
        "noncanonical": "ignore me",
    }

    assert _build_pre_extracted(profile) == {
        "profile_url": "https://www.linkedin.com/in/test-person",
        "full_name": "Test Person",
        "headline": "Engineer",
        "skills": ["Python"],
        "education": [{"school": "UTN"}],
        "courses": ["ML Ops"],
        "languages": ["English"],
    }
