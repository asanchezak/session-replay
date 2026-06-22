"""Unit tests for the AI self-healing (shadow) core logic — the parts that gate trust
without needing a DB or a live LLM: offline selector validation, selector tokenizing,
diagnosis parsing, strategy extraction, and contract lookup."""
from services.self_healing_service import (
    _contract_for,
    _offline_validate,
    _parse_diagnosis,
    _selector_tokens,
    _strategy_from_error,
)


def _evidence_with_dom(dom_fragment: str) -> dict:
    # Mirrors a recruiter strategy's diag: a *_result dict carrying captured DOM HTML.
    return {"diag": {"note_compose_result": {"diag": {"bulk_bar": {"bulk_actions": dom_fragment}}}}}


# ── offline validation (the 'no live trial-and-error' safety gate) ──────────────
def test_offline_validate_matches_when_selector_in_captured_dom():
    ev = _evidence_with_dom("<button data-test-action='add-note'>Añadir nota</button>")
    fix = {"type": "selector_swap", "old_selector": ".old", "new_selector": "[data-test-action='add-note']"}
    res = _offline_validate(fix, ev)
    assert res["performed"] is True
    assert res["matched_in_evidence"] is True


def test_offline_validate_flags_selector_not_in_dom():
    ev = _evidence_with_dom("<button data-test-action='send-message'>Mensaje</button>")
    fix = {"type": "selector_swap", "new_selector": "[data-test-action='this-does-not-exist']"}
    res = _offline_validate(fix, ev)
    assert res["performed"] is True
    assert res["matched_in_evidence"] is False  # low trust — would NOT be auto-applied


def test_offline_validate_skips_non_selector_fix():
    res = _offline_validate({"type": "relaunch"}, _evidence_with_dom("<div/>"))
    assert res["performed"] is False
    assert res["matched_in_evidence"] is None


def test_offline_validate_no_dom_evidence():
    fix = {"type": "selector_swap", "new_selector": "[data-test-action='add-note']"}
    res = _offline_validate(fix, {"diag": {}})
    assert res["performed"] is False
    assert res["matched_in_evidence"] is None


# ── selector tokenizing ─────────────────────────────────────────────────────────
def test_selector_tokens_extracts_data_test_and_value_and_class():
    toks = _selector_tokens("button[data-test-create-edit-note-submit-btn].artdeco-button[type='submit']")
    assert "data-test-create-edit-note-submit-btn" in toks
    assert "submit" in toks
    assert "artdeco-button" in toks


# ── diagnosis parsing (tolerant of fences / mock output) ────────────────────────
def test_parse_diagnosis_plain_json():
    d = _parse_diagnosis('{"failure_class": "selector_drift", "confidence": 0.9}')
    assert d["failure_class"] == "selector_drift"
    assert d["confidence"] == 0.9


def test_parse_diagnosis_code_fenced():
    d = _parse_diagnosis('```json\n{"failure_class": "locale_flip"}\n```')
    assert d["failure_class"] == "locale_flip"


def test_parse_diagnosis_non_json_is_graceful():
    d = _parse_diagnosis('{"result": "mock_success", "confidence": 0.85}')
    # Mock/odd output → defaults preserved, no crash.
    assert d["failure_class"] == "unknown"
    assert "proposed_fix" in d


# ── strategy extraction + contract lookup ───────────────────────────────────────
def test_strategy_from_error():
    assert _strategy_from_error("recruiter_note_compose stage failed: note_failed") == "recruiter_note_compose"
    assert _strategy_from_error("step 2 'click X' failed: missing") is None


def test_contract_for_known_and_generic():
    known = _contract_for("recruiter_note_compose")
    assert "success_criteria" in known and "failure_reasons" in known
    generic = _contract_for("totally_unknown_strategy")
    assert generic.get("intent")  # falls back to _generic_step contract
