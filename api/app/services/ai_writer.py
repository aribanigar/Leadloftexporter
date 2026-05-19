"""Claude-powered AI email writer + reply classifier.

Uses prompt caching on the static system+style sections so each per-lead
generation only pays for the dynamic part.
"""
from __future__ import annotations

import json
from typing import Optional

from anthropic import Anthropic

from app.core.config import get_settings
from app.models import Lead, Workspace

_settings = get_settings()
_client: Optional[Anthropic] = None


def _client_or_none() -> Optional[Anthropic]:
    global _client
    if not _settings.anthropic_api_key:
        return None
    if _client is None:
        _client = Anthropic(api_key=_settings.anthropic_api_key)
    return _client


SYSTEM_PROMPT = """You are an elite B2B sales copywriter writing on behalf of a salesperson.
Write short, human, specific outreach emails — never marketing-speak.

Rules:
- Greet by first name only.
- Open with a single specific observation from the prospect's profile (role, company, location, recent move).
- One concrete value statement tied to their world.
- One light-touch CTA — a question, not a demand.
- 80-130 words max. No emojis. No "Hope you're doing well." No "I came across your profile."
- Return JSON: {"subject": "...", "body_text": "...", "body_html": "<p>...</p>"}.
"""


def _lead_context(lead: Optional[Lead]) -> str:
    if not lead:
        return "No specific lead — write a generic but human cold email."
    parts = [
        f"Name: {lead.full_name or lead.first_name or 'there'}",
        f"Title: {lead.title or '-'}",
        f"Headline: {lead.headline or '-'}",
        f"Location: {lead.location or '-'}",
        f"Company: {lead.company.name if lead.company else '-'}",
    ]
    if lead.company and lead.company.description:
        parts.append(f"Company desc: {lead.company.description[:300]}")
    return "\n".join(parts)


def generate_email_for_lead(
    lead: Optional[Lead],
    *,
    instruction: str,
    tone: str = "professional",
    workspace: Optional[Workspace] = None,
) -> dict:
    client = _client_or_none()
    if not client:
        # Local fallback so the UI keeps working without an API key.
        name = (lead.first_name or (lead.full_name or "there").split(" ")[0]) if lead else "there"
        company = lead.company.name if (lead and lead.company) else "your team"
        subject = f"Quick idea for {company}"
        body = (
            f"Hi {name},\n\n"
            f"Saw you're {lead.title or 'leading work'} at {company}. {instruction}\n\n"
            f"Worth a quick 15-minute chat next week?\n\nBest,"
        )
        return {
            "subject": subject,
            "body_text": body,
            "body_html": "<p>" + body.replace("\n\n", "</p><p>").replace("\n", "<br/>") + "</p>",
        }

    style = ""
    if workspace:
        style = (workspace.settings or {}).get("ai_style", "")

    response = client.messages.create(
        model=_settings.anthropic_model,
        max_tokens=600,
        system=[
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
            {
                "type": "text",
                "text": f"Workspace voice/style notes:\n{style or '(none)'}",
                "cache_control": {"type": "ephemeral"},
            },
        ],
        messages=[
            {
                "role": "user",
                "content": (
                    f"Tone: {tone}\nGoal: {instruction}\n\nLead context:\n{_lead_context(lead)}\n\n"
                    "Return ONLY the JSON object."
                ),
            }
        ],
    )
    text = "".join(block.text for block in response.content if getattr(block, "type", "") == "text")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        data = json.loads(text[start : end + 1]) if start >= 0 and end > start else {}
    return {
        "subject": data.get("subject", ""),
        "body_text": data.get("body_text", ""),
        "body_html": data.get("body_html") or "<p>" + (data.get("body_text") or "").replace("\n", "<br/>") + "</p>",
    }


def classify_reply_sentiment(text: str) -> dict:
    client = _client_or_none()
    if not client:
        lowered = text.lower()
        if any(w in lowered for w in ("yes", "interested", "sure", "happy to", "let's", "sounds good")):
            return {"sentiment": "positive", "confidence": 0.6}
        if any(w in lowered for w in ("not interested", "no thanks", "remove", "unsubscribe", "stop")):
            return {"sentiment": "negative", "confidence": 0.6}
        return {"sentiment": "neutral", "confidence": 0.4}
    response = client.messages.create(
        model=_settings.anthropic_fast_model,
        max_tokens=50,
        system="Classify the reply as one of: positive, neutral, negative, ooo (out of office). Respond JSON: {\"sentiment\": \"...\", \"confidence\": 0.0-1.0}.",
        messages=[{"role": "user", "content": text[:4000]}],
    )
    text_out = "".join(b.text for b in response.content if getattr(b, "type", "") == "text")
    try:
        return json.loads(text_out)
    except Exception:
        return {"sentiment": "neutral", "confidence": 0.4}
