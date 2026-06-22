import json
from typing import Any

from app.core.config import settings
from app.schemas.api import SelectorReviewRequest, SelectorReviewResponse
from app.services.llm_service import get_llm_provider

SELECTOR_KEYS = [
    "containerSelector",
    "messageSelector",
    "textSelector",
    "senderSelector",
    "timeSelector",
]


def heuristic_review(payload: SelectorReviewRequest) -> SelectorReviewResponse:
    selectors = {key: payload.selectors.get(key, "") for key in SELECTOR_KEYS}
    stats = payload.selector_stats or {}
    issues: list[str] = []

    container_count = int(stats.get("containerCount") or 0)
    message_count = int(stats.get("messageCount") or 0)
    text_empty_count = int(stats.get("textEmptyCount") or 0)
    if container_count == 0:
        issues.append("Container selector matches 0 elements.")
    if container_count > 1:
        issues.append("Container selector matches multiple elements; prefer a more specific container.")
    if message_count == 0:
        issues.append("Message selector matches 0 elements inside the container.")
    if message_count == 1:
        issues.append("Message selector only matches one item. It may be too specific, for example using a unique id.")
    if text_empty_count > 0:
        issues.append("Some matched messages have empty text extraction.")
    if "#" in selectors.get("messageSelector", ""):
        issues.append("Message selector contains an id. For repeated messages, prefer tag.class such as li.content-item.")

    confidence = 0.85 if not issues and message_count >= 2 else 0.45
    summary = "Selectors look usable." if not issues else "Selectors need review before reliable capture."
    return SelectorReviewResponse(
        status="mock",
        summary=summary,
        recommended_selectors=selectors,
        issues=issues,
        confidence=confidence,
    )


def build_prompt(payload: SelectorReviewRequest) -> str:
    # Feed the actual page HTML (compact) plus the sample text to the LLM so it can
    # locate the right elements and emit structured selectors. Fall back to the
    # JSON evidence summary when page_html is unavailable.
    page_html = (payload.page_html or "").strip()
    sample_text = (payload.sample_text or "").strip()
    current = json.dumps(payload.selectors or {}, ensure_ascii=False, indent=2)
    nl = chr(10)

    if page_html:
        html_blob = page_html[:60000]
        sample_block = (
            "User-provided sample message text (a real piece of text that appears inside one message on the page):"
            + nl + sample_text + nl + nl
        ) if sample_text else ""
        evidence = (
            "Current selectors being reviewed:" + nl + current + nl + nl
            + sample_block
            + "Page HTML (compact, may be truncated):" + nl + html_blob + nl + nl
            + "Page URL: " + (payload.page_url or "") + nl
            + "Page title: " + (payload.title or "")
        )
        instruction = (
            "You are a browser-extension DOM selector agent. The user has pasted a snippet of real message text that "
            "exists on the current page, and the full (compact) page HTML is provided below. Your job is to locate, "
            "INSIDE that HTML, the DOM elements that represent: (1) the chat/message list container, (2) a single "
            "repeated message row, (3) the message body text, (4) the sender name, and (5) the timestamp. "
            "Derive reusable CSS selectors (prefer tag.class over unique ids; selectors must match multiple message rows). "
            "The container selector must be resolvable by document.querySelector; the message selector by container.querySelector; "
            "text/sender/time selectors by message.querySelector. Use the sample text to anchor which element holds the message body. "
            "Do NOT ask for cookies or credentials; everything you need is in the HTML below."
        )
    else:
        compact = json.dumps(payload.model_dump(), ensure_ascii=False, indent=2)[:18000]
        evidence = "Evidence:" + nl + compact
        instruction = (
            "You are a browser-extension DOM selector review agent. Review whether the selectors reliably capture "
            "chat or comment messages. Prefer reusable selectors over unique ids. Use the current logged-in page evidence "
            "provided by the extension; do not ask for cookies or credentials."
        )

    footer = (
        "Return STRICT JSON ONLY (no markdown, no code fences) with exactly these keys: "
        "summary (string), recommended_selectors (object with keys containerSelector, messageSelector, "
        "textSelector, senderSelector, timeSelector - all strings, empty string if not found), "
        "issues (array of strings), confidence (number between 0 and 1)."
    )
    return instruction + nl + nl + footer + nl + nl + evidence


def review_selectors(payload: SelectorReviewRequest) -> SelectorReviewResponse:
    if not settings.openai_api_key:
        return heuristic_review(payload)

    llm = get_llm_provider()
    try:
        raw = llm.generate(build_prompt(payload))
    except Exception as exc:
        fallback = heuristic_review(payload)
        fallback.status = "llm_fallback"
        fallback.summary = f"{fallback.summary} LLM review failed, so heuristic review was used."
        fallback.issues = [*fallback.issues, f"LLM error: {type(exc).__name__}: {exc}"]
        fallback.raw_response = None
        return fallback

    try:
        parsed: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError:
        try:
            start = raw.find("{")
            end = raw.rfind("}")
            parsed = json.loads(raw[start : end + 1]) if start >= 0 and end > start else {}
        except json.JSONDecodeError:
            fallback = heuristic_review(payload)
            fallback.status = "llm_parse_fallback"
            fallback.summary = f"{fallback.summary} LLM returned non-JSON content, so heuristic review was used."
            fallback.issues = [*fallback.issues, "LLM response was not valid JSON."]
            fallback.raw_response = raw[:2000]
            return fallback

    recommended = parsed.get("recommended_selectors") or payload.selectors
    issues = parsed.get("issues") or []
    if isinstance(issues, str):
        issues = [issues]
    return SelectorReviewResponse(
        status="ok",
        summary=str(parsed.get("summary") or "Selector review completed."),
        recommended_selectors={key: str(recommended.get(key, "")) for key in SELECTOR_KEYS},
        issues=[str(issue) for issue in issues],
        confidence=float(parsed.get("confidence") or 0.0),
        raw_response=raw,
    )
