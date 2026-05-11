SELECTOR_HEAL_SYSTEM = """You are a DOM analysis assistant. Given:
1. A snippet of the current page DOM around where the target element should be
2. The accessibility tree snippet for the same region
3. The old selectors that worked on a previous version of the page
4. The user's intent for this action

Return a JSON object with:
- "selector": The best CSS selector for the target element on the current page
- "confidence": A float between 0.0 and 1.0
- "explanation": Brief explanation of what changed and how you found it
- "fallback_selectors": Array of alternative selectors

Use text content, accessibility attributes, and DOM structure to find the element.
Only return valid JSON, no other text."""

CLASSIFY_CHALLENGE_SYSTEM = """You are a page state classifier. Given a snapshot of the current page, determine if the user needs to intervene.

Classify as one of:
- "clean": No intervention needed, automation can continue
- "captcha": CAPTCHA or bot challenge detected
- "login": Login or authentication form detected
- "2fa": Two-factor authentication challenge
- "modal": Unexpected dialog or modal blocking interaction
- "error": Error page or message
- "ambiguous": Cannot determine, needs human review

Return JSON: {"classification": str, "confidence": float, "reason": str}"""

EXTRACT_SYSTEM = """You are a data extraction assistant. Given page content and a schema, extract structured data.

Return a JSON array of objects matching the requested schema.
If no data is found, return an empty array.
Only return valid JSON."""


def build_heal_prompt(
    dom_snippet: str,
    at_snippet: str | None,
    old_selectors: list[str],
    intent: str,
) -> str:
    parts = [
        f"## Current DOM snippet:\n{dom_snippet[:2000]}",
    ]
    if at_snippet:
        parts.append(f"\n## Accessibility tree:\n{at_snippet[:1000]}")
    parts.append(f"\n## Old selectors:\n{', '.join(old_selectors)}")
    parts.append(f"\n## User intent:\n{intent}")
    return "\n".join(parts)


def build_classify_prompt(page_text: str, visible_elements: list[str]) -> str:
    return (
        f"## Page text content:\n{page_text[:1500]}\n"
        f"## Visible interactive elements:\n{', '.join(visible_elements[:30])}"
    )


def build_extract_prompt(page_content: str, schema: dict) -> str:
    import json
    return (
        f"## Page content:\n{page_content[:3000]}\n"
        f"## Expected schema:\n{json.dumps(schema, indent=2)}"
    )
