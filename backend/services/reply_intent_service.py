"""AI classification of candidate replies to Recruiter outreach.

The daemon's inbox scan reads the reply TEXT of candidates we messaged; this
module classifies each reply's intent in ONE batched AI call before the payload
is pushed to Odoo (/akcr/api/lead_replied stores category + body on the lead).

Categories (fixed contract with akcr's linkedin.lead.reply_category):
  interested     — wants to proceed / asks about the role, salary, or process
  not_interested — declines (drops the lead off the reply watchlist in Odoo)
  maybe_later    — declines for now but explicitly open to future contact
  unclear        — greetings, auto-replies, ambiguous — ALSO the failure fallback

Best-effort by design: any AI failure yields 'unclear' for the affected replies
and never blocks the push (the lead still flips to 'responded').
"""
import json
import logging

from ai.client import get_ai_provider

logger = logging.getLogger(__name__)

CATEGORIES = ("interested", "not_interested", "maybe_later", "unclear")

_MAX_BODY_CHARS = 2000

_SYSTEM_PROMPT = (
    "You classify candidate replies to a recruiter's LinkedIn outreach about a job "
    "opening. Input is a JSON array of items {id, name, body} where body is the "
    "candidate's reply text (any language). Respond with ONLY a JSON array — no prose, "
    'no code fences: [{"id": <same id>, "category": "<one of: interested | '
    'not_interested | maybe_later | unclear>", "reason": "<at most 15 words, in the '
    'same language as the reply>"}].\n'
    "interested = wants to proceed, accepts, or engages with the opportunity in any "
    "way: asking about the role, salary, process, or company; requesting the job "
    "description or a working application link; reporting a broken link so they can "
    "apply. Any question that moves the conversation forward is interest.\n"
    "not_interested = declines the opportunity.\n"
    "maybe_later = declines for now but is explicitly open to future contact.\n"
    "unclear = pure greetings, auto-replies, or anything that signals neither "
    "interest nor decline."
)

_FALLBACK = {"category": "unclear", "reason": "classification_failed"}


def _parse_classification(content: str, count: int) -> list[dict]:
    """Parse the AI's JSON array into a list aligned by item id (0..count-1).
    Any missing/invalid item falls back to 'unclear'."""
    out = [dict(_FALLBACK) for _ in range(count)]
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        # a fence may carry a language tag ("json\n[...")
        if "\n" in text:
            first, rest = text.split("\n", 1)
            if first.strip().lower() in ("json", ""):
                text = rest
    try:
        items = json.loads(text)
    except Exception:
        logger.warning("reply-intent: unparseable AI response: %.200s", text)
        return out
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if not (0 <= idx < count):
            continue
        category = str(item.get("category") or "").strip().lower()
        if category not in CATEGORIES:
            continue
        reason = str(item.get("reason") or "").strip()[:200]
        out[idx] = {"category": category, "reason": reason}
    return out


async def classify_replies(replies: list[dict]) -> list[dict]:
    """Classify reply intents. `replies` is a list of {name?, body} dicts; returns a
    list of {category, reason} aligned by index. One batched AI call for the whole
    list; never raises (falls back to 'unclear')."""
    if not replies:
        return []
    items = [
        {
            "id": i,
            "name": (r.get("name") or "")[:120],
            "body": (r.get("body") or "")[:_MAX_BODY_CHARS],
        }
        for i, r in enumerate(replies)
    ]
    prompt = json.dumps(items, ensure_ascii=False)
    try:
        provider = get_ai_provider()
        resp = await provider.generate(
            prompt,
            system=_SYSTEM_PROMPT,
            max_tokens=200 + 80 * len(items),
        )
        results = _parse_classification(resp.content, len(items))
    except Exception:
        logger.exception("reply-intent: AI classification failed — all 'unclear'")
        results = [dict(_FALLBACK) for _ in items]
    for it, res in zip(items, results):
        logger.info(
            "reply-intent: %r → %s (%s)", it["name"], res["category"], res["reason"]
        )
    return results
