from __future__ import annotations

import re
from typing import Any

from services.agent_models import AgentCommand, CommandAction

_LINKEDIN_TOP_NAV_LABELS = {"home", "my network", "jobs", "messaging", "notifications", "me"}


def selector_chain_has_shadow_host(step: dict[str, Any], host_fragment: str) -> bool:
    selector_chain = step.get("selector_chain") or []
    if not isinstance(selector_chain, list):
        return False
    host_fragment_l = host_fragment.lower()
    for sel in selector_chain:
        if not isinstance(sel, dict):
            continue
        value = str(sel.get("value") or "").lower()
        if sel.get("type") == "shadow_css" and host_fragment_l in value:
            return True
    return False


def selector_chain_texts(step: dict[str, Any]) -> list[str]:
    out: list[str] = []
    selector_chain = step.get("selector_chain") or []
    if not isinstance(selector_chain, list):
        return out
    for sel in selector_chain:
        if not isinstance(sel, dict) or str(sel.get("type") or "").lower() != "text":
            continue
        value = sel.get("value")
        if isinstance(value, str):
            text = re.sub(r"\s+", " ", value).strip()
            if text:
                out.append(text)
    return out


def extract_click_label(step: dict[str, Any]) -> str | None:
    if not isinstance(step, dict):
        return None
    selector_chain = step.get("selector_chain")
    if isinstance(selector_chain, list):
        for raw_sel in selector_chain:
            if not isinstance(raw_sel, dict):
                continue
            if str(raw_sel.get("type") or "").lower() != "text":
                continue
            raw_text = raw_sel.get("value")
            if not isinstance(raw_text, str):
                continue
            text_label = re.sub(r"\s+", " ", raw_text).strip()
            if text_label:
                return text_label[:120]
    raw_value = step.get("value")
    if isinstance(raw_value, str):
        value = re.sub(r"\s+", " ", raw_value).strip()
        if value:
            return value[:120]
    raw_intent = step.get("intent")
    if not isinstance(raw_intent, str):
        return None
    intent = re.sub(r"\s+", " ", raw_intent).strip()
    if not intent:
        return None
    quoted = [
        re.sub(r"\s+", " ", part).strip()
        for part in re.findall(r'"([^"]+)"', intent)
    ]
    quoted = [part for part in quoted if part]
    if quoted:
        quoted.sort(key=lambda part: len(part), reverse=True)
        return quoted[0][:120]
    cleaned = re.sub(
        r"^(click|tap|press|select|choose|open)\s+",
        "",
        intent,
        flags=re.IGNORECASE,
    ).strip()
    cleaned = re.sub(r"^(on|the|a|an)\s+", "", cleaned, flags=re.IGNORECASE).strip()
    if not cleaned or len(cleaned) > 80:
        return None
    return cleaned[:120]


class LinkedInSiteAdapter:
    """Semantic compiler for LinkedIn workflows.

    The recorder still stores raw selector evidence, but replay should use
    LinkedIn operations for dynamic surfaces such as top nav and messaging.
    """

    site = "linkedin"
    harness = "site:linkedin"

    def compile_command(self, step: dict[str, Any], ctx: Any) -> AgentCommand | None:
        if not isinstance(step, dict):
            return None
        url = str(getattr(ctx, "url", "") or "").lower()
        intent = re.sub(r"\s+", " ", str(step.get("intent") or "")).strip()
        intent_l = intent.lower()
        has_linkedin_shadow = selector_chain_has_shadow_host(step, "interop-shadowdom")
        if "linkedin.com" not in url and not has_linkedin_shadow and "linkedin" not in intent_l:
            return None

        action_type = str(step.get("action_type") or "").lower()
        label = extract_click_label(step) or ""
        label_l = label.lower()
        texts = selector_chain_texts(step)
        value = step.get("value")

        operation: str | None = None
        args: dict[str, Any] = {}
        scope = "messaging_dock" if has_linkedin_shadow else "any"

        if action_type in {"click", "select"}:
            if "messaging" in label_l and (
                "overlay" in label_l or "conversation" in label_l or label_l == "messaging"
            ):
                operation = "open_messaging_dock"
                scope = "global_nav"
            elif label_l == "send" or 'button "send"' in intent_l:
                operation = "send_message"
                scope = "messaging_dock"
            elif "write a message" in label_l or "write a message" in intent_l:
                operation = "focus_message_composer"
                scope = "messaging_dock"
            elif has_linkedin_shadow and texts:
                operation = "open_conversation"
                scope = "messaging_dock"
                args["name"] = texts[0]
            elif label:
                operation = "click"
                scope = "global_nav" if label_l in _LINKEDIN_TOP_NAV_LABELS else scope
                args["label"] = label
        elif (
            action_type == "type"
            and isinstance(value, str)
            and (has_linkedin_shadow or "write a message" in intent_l)
        ):
            operation = "type_message"
            scope = "messaging_dock"
            args["text"] = value

        if not operation:
            return None

        script_args = {
            "__harness": self.harness,
            "site": self.site,
            "operation": operation,
            "scope": scope,
            **args,
        }
        success_condition = (
            {"type": "visible_text_contains", "value": value}
            if operation == "type_message" and isinstance(value, str)
            else (
                step.get("success_condition")
                if isinstance(step.get("success_condition"), dict)
                else None
            )
        )

        return AgentCommand(
            action=CommandAction.RUN_SCRIPT,
            intent=f"LinkedIn site adapter: {operation}",
            script="site_adapter:linkedin",
            script_args=script_args,
            script_timeout_ms=12_000,
            timeout_ms=20_000,
            success_condition=success_condition,
        )
