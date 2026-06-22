"""Unit tests for the grouped boolean assembly (OR-clusters instead of a rigid AND chain)."""
from services.boolean_query_builder import BooleanQueryBuilder, _clean_groups


def test_assemble_groups_as_or_clusters():
    spec = {
        "title_variants": ["Senior Data Engineer", "ML Engineer"],
        "must_have_skills": [
            ["Kafka", "Airflow", "Spark", "streaming"],
            ["AWS"],
            ["Kubernetes", "Docker", "Terraform"],
            ["MLOps", "model serving", "machine learning"],
        ],
        "optional_skills": [],
        "exclude": ["Manager", "Intern"],
    }
    q = BooleanQueryBuilder().assemble(spec, tightness=4)
    assert q == (
        '("Senior Data Engineer" OR "ML Engineer") '
        'AND ("Kafka" OR "Airflow" OR "Spark" OR "streaming") '
        'AND "AWS" '
        'AND ("Kubernetes" OR "Docker" OR "Terraform") '
        'AND ("MLOps" OR "model serving" OR "machine learning") '
        'NOT ("Manager" OR "Intern")'
    )


def test_tightness_limits_groups():
    spec = {
        "title_variants": ["Data Engineer"],
        "must_have_skills": [["Kafka", "Airflow"], ["AWS"], ["Kubernetes", "Docker"]],
        "optional_skills": [],
    }
    q = BooleanQueryBuilder().assemble(spec, tightness=1)
    assert q == '("Data Engineer") AND ("Kafka" OR "Airflow")'


def test_assemble_tolerates_legacy_flat_spec():
    # An old stored spec with flat string skills must still assemble (back-compat).
    spec = {"title_variants": ["DE"], "must_have_skills": ["Kafka", "AWS"], "optional_skills": []}
    q = BooleanQueryBuilder().assemble(spec, tightness=2)
    assert q == '("DE") AND "Kafka" AND "AWS"'


def test_optionals_never_gate_even_at_high_tightness():
    # Regression: a nice-to-have (e.g. "OpenAI") must NEVER become a hard AND, at any tightness.
    spec = {
        "title_variants": ["Senior Data Engineer"],
        "must_have_skills": [["Kafka", "Airflow"], ["AWS"], ["Docker", "Kubernetes"]],
        "optional_skills": [["OpenAI"], ["LangChain"]],
        "exclude": ["Manager"],
    }
    b = BooleanQueryBuilder()
    q = b.assemble(spec, tightness=6)  # higher than #must groups
    assert "OpenAI" not in q and "LangChain" not in q
    assert q == (
        '("Senior Data Engineer") AND ("Kafka" OR "Airflow") AND "AWS" '
        'AND ("Docker" OR "Kubernetes") NOT ("Manager")'
    )
    assert b.max_tightness(spec) == 3  # only must groups count


def test_clean_groups_normalizes_and_strips_versions():
    groups = _clean_groups(
        [["Next.js 15", "Next.js"], "AWS", ["", "  "], ["Kafka", "Kafka"]], cap_groups=6
    )
    # version stripped + dedup within group; bare string -> 1-term group; empty group dropped
    assert groups == [["Next.js"], ["AWS"], ["Kafka"]]
