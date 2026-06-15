"""Meeting notetaker — transcription + note generation.

Two stages, each with a graceful fallback:

1. **Transcription** (audio → text). Needs a speech-to-text service; we use
   OpenAI Whisper (``POST /v1/audio/transcriptions``) when ``OPENAI_API_KEY`` is
   set. Claude cannot transcribe audio, so without a key the caller must paste a
   transcript instead.
2. **Notes** (transcript → summary + action items). Uses Claude when
   ``ANTHROPIC_API_KEY`` is set, else a deterministic extractive fallback so the
   feature still produces something useful with no AI key.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Optional

import httpx

from app.core.config import get_settings

log = logging.getLogger(__name__)
_settings = get_settings()


def transcription_enabled() -> bool:
    return bool(_settings.openai_api_key)


def transcribe_audio(data: bytes, filename: str) -> str:
    """Transcribe an audio file via Whisper. Raises if not configured."""
    if not _settings.openai_api_key:
        raise RuntimeError(
            "transcription_not_configured: set OPENAI_API_KEY on the backend to transcribe audio, "
            "or paste a transcript instead."
        )
    resp = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {_settings.openai_api_key}"},
        files={"file": (filename or "audio.mp3", data)},
        data={"model": _settings.whisper_model, "response_format": "text"},
        timeout=300,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"transcription_failed: {resp.status_code} {resp.text[:300]}")
    return resp.text.strip()


def make_notes(transcript: str, *, context: str = "") -> dict:
    """Return {summary, action_items[]} from a transcript."""
    transcript = (transcript or "").strip()
    if not transcript:
        return {"summary": "", "action_items": []}

    if _settings.anthropic_api_key:
        try:
            return _ai_notes(transcript, context)
        except Exception as exc:  # noqa: BLE001
            log.warning("AI notes failed, using fallback: %s", exc)
    return _fallback_notes(transcript)


def _ai_notes(transcript: str, context: str) -> dict:
    from anthropic import Anthropic

    client = Anthropic(api_key=_settings.anthropic_api_key)
    # Cap very long transcripts to keep latency/cost sane.
    body = transcript[:48000]
    resp = client.messages.create(
        model=_settings.anthropic_fast_model,
        max_tokens=1200,
        system=(
            "You summarize a sales/meeting transcript for the rep. Return STRICT JSON only: "
            '{"summary": "<6-10 sentence summary of what was discussed, decisions, and next steps>", '
            '"action_items": ["<short imperative action>", ...]}. '
            "Action items are concrete follow-ups for the rep. No preamble, no code fences."
        ),
        messages=[
            {"role": "user", "content": (f"Context: {context}\n\n" if context else "") + f"Transcript:\n{body}"}
        ],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", "") == "text").strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        s, e = text.find("{"), text.rfind("}")
        data = json.loads(text[s : e + 1]) if s >= 0 and e > s else {}
    items = data.get("action_items") or []
    if not isinstance(items, list):
        items = [str(items)]
    return {"summary": (data.get("summary") or "").strip(), "action_items": [str(i).strip() for i in items if str(i).strip()]}


def _fallback_notes(transcript: str) -> dict:
    """No-AI extractive notes: first sentences as a summary + lines that look
    like commitments as action items."""
    sentences = re.split(r"(?<=[.!?])\s+", transcript)
    summary = " ".join(sentences[:6]).strip()
    if len(summary) > 1200:
        summary = summary[:1200] + "…"
    cues = ("i'll", "i will", "we'll", "we will", "let's", "follow up", "follow-up", "next step", "send", "schedule", "action")
    actions: list[str] = []
    for s in sentences:
        low = s.lower()
        if any(c in low for c in cues):
            clean = s.strip()
            if 8 <= len(clean) <= 200 and clean not in actions:
                actions.append(clean)
        if len(actions) >= 10:
            break
    return {"summary": summary, "action_items": actions}
