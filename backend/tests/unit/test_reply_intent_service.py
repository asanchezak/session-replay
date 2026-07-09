"""Unit tests for the reply-intent classifier (inbox-reply AI classification)."""
import asyncio
import json

from services import reply_intent_service as ris
from services.reply_intent_service import _parse_classification, classify_replies


class _FakeResponse:
    def __init__(self, content):
        self.content = content


class _FakeProvider:
    def __init__(self, content):
        self._content = content
        self.calls = []

    async def generate(self, prompt, system=None, max_tokens=None, images=None):
        self.calls.append({"prompt": prompt, "system": system, "max_tokens": max_tokens})
        return _FakeResponse(self._content)


class _BoomProvider:
    async def generate(self, *a, **kw):
        raise RuntimeError("AI down")


# ------------------------------------------------------------------ parsing

def test_parse_clean_json():
    content = json.dumps([
        {"id": 0, "category": "interested", "reason": "asks about the role"},
        {"id": 1, "category": "not_interested", "reason": "declina"},
    ])
    out = _parse_classification(content, 2)
    assert out[0] == {"category": "interested", "reason": "asks about the role"}
    assert out[1] == {"category": "not_interested", "reason": "declina"}


def test_parse_fenced_json():
    content = '```json\n[{"id": 0, "category": "maybe_later", "reason": "quizás luego"}]\n```'
    out = _parse_classification(content, 1)
    assert out[0]["category"] == "maybe_later"


def test_parse_missing_id_falls_back():
    content = json.dumps([{"id": 1, "category": "interested", "reason": "ok"}])
    out = _parse_classification(content, 2)
    assert out[0]["category"] == "unclear"
    assert out[0]["reason"] == "classification_failed"
    assert out[1]["category"] == "interested"


def test_parse_invalid_category_falls_back():
    content = json.dumps([{"id": 0, "category": "super_excited", "reason": "x"}])
    out = _parse_classification(content, 1)
    assert out[0]["category"] == "unclear"


def test_parse_out_of_range_and_garbage_ids():
    content = json.dumps([
        {"id": 5, "category": "interested", "reason": "x"},
        {"id": "nope", "category": "interested", "reason": "x"},
        "not-a-dict",
    ])
    out = _parse_classification(content, 1)
    assert out[0]["category"] == "unclear"


def test_parse_non_json_prose():
    out = _parse_classification("The candidate seems interested.", 1)
    assert out[0]["category"] == "unclear"


def test_parse_non_list_json():
    out = _parse_classification('{"category": "interested"}', 1)
    assert out[0]["category"] == "unclear"


def test_parse_reason_truncated():
    content = json.dumps([{"id": 0, "category": "interested", "reason": "r" * 500}])
    out = _parse_classification(content, 1)
    assert len(out[0]["reason"]) == 200


# ------------------------------------------------------------------ classify_replies

def test_classify_batches_one_call_and_aligns(monkeypatch):
    provider = _FakeProvider(json.dumps([
        {"id": 0, "category": "interested", "reason": "wants to talk"},
        {"id": 1, "category": "not_interested", "reason": "no gracias"},
    ]))
    monkeypatch.setattr(ris, "get_ai_provider", lambda: provider)
    replies = [
        {"name": "Alice", "body": "Me interesa, ¿cuándo hablamos?"},
        {"name": "Bob", "body": "No thanks, I'm happy where I am."},
    ]
    out = asyncio.run(classify_replies(replies))
    assert len(provider.calls) == 1  # ONE batched call
    assert [v["category"] for v in out] == ["interested", "not_interested"]
    sent = json.loads(provider.calls[0]["prompt"])
    assert [it["id"] for it in sent] == [0, 1]
    assert sent[0]["name"] == "Alice"


def test_classify_truncates_long_bodies(monkeypatch):
    provider = _FakeProvider(json.dumps([{"id": 0, "category": "unclear", "reason": ""}]))
    monkeypatch.setattr(ris, "get_ai_provider", lambda: provider)
    asyncio.run(classify_replies([{"name": "X", "body": "y" * 10_000}]))
    sent = json.loads(provider.calls[0]["prompt"])
    assert len(sent[0]["body"]) == 2000


def test_classify_provider_exception_all_unclear(monkeypatch):
    monkeypatch.setattr(ris, "get_ai_provider", lambda: _BoomProvider())
    out = asyncio.run(classify_replies([
        {"name": "A", "body": "hola"},
        {"name": "B", "body": "hi"},
    ]))
    assert all(v == {"category": "unclear", "reason": "classification_failed"} for v in out)


def test_classify_empty_input():
    assert asyncio.run(classify_replies([])) == []


# ------------------------------------------------------------------ pipeline merge

def test_record_inbox_replies_merges_categories(monkeypatch):
    """Classified categories must land on the reply dicts pushed to Odoo, and
    body-less replies must pass through unclassified."""
    from services.recruiter_pipeline_service import RecruiterPipelineService

    svc = RecruiterPipelineService.__new__(RecruiterPipelineService)

    async def fake_classify(replies):
        return [{"category": "interested", "reason": "asks about salary"}]

    import services.recruiter_pipeline_service as rps
    monkeypatch.setattr(rps, "classify_replies", fake_classify)

    async def fake_connector():
        return "conn-1"
    svc._latest_recruiter_connector = fake_connector

    captured = {}

    class _FakePush:
        async def push_inbox_replies(self, *, connector_id, replied, run_id=None):
            captured["connector_id"] = connector_id
            captured["replied"] = replied
            return {"pushed": len(replied)}

    svc.push = _FakePush()

    replies = [
        {"name": "Karthikeya J", "body": "Can you share the JD?", "via": "unread",
         "conversation_urn": "urn:x"},
        {"name": "Silent Sam", "via": "unread", "conversation_urn": ""},
    ]
    res = asyncio.run(svc.record_inbox_replies(replies))
    assert res["status"] == "ok"
    assert res["classified"] == 1
    pushed = captured["replied"]
    assert pushed[0]["category"] == "interested"
    assert pushed[0]["category_reason"] == "asks about salary"
    assert "category" not in pushed[1]
