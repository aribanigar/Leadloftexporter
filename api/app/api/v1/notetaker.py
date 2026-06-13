"""Meeting notetaker API — upload an audio recording (or paste a transcript),
get a transcript + summary + action items, and optionally attach the notes to a
lead's timeline.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Activity, Lead, MeetingNote, Note
from app.services import notetaker as nt

router = APIRouter(prefix="/notetaker", tags=["notetaker"])

# Audio types Whisper accepts; we gate on extension/content-type loosely.
MAX_AUDIO_BYTES = 60 * 1024 * 1024  # 60 MB


def _serialize(m: MeetingNote) -> dict:
    return {
        "id": m.id,
        "title": m.title,
        "transcript": m.transcript,
        "summary": m.summary,
        "action_items": m.action_items or [],
        "source": m.source,
        "status": m.status,
        "error": m.error,
        "lead_id": m.lead_id,
        "created_at": m.created_at,
    }


@router.get("/status")
def status_(ctx: AuthContext = Depends(get_workspace_context)):
    return {"transcription_enabled": nt.transcription_enabled()}


@router.get("")
def list_notes(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(MeetingNote)
        .filter(MeetingNote.workspace_id == ctx.workspace_id)
        .order_by(MeetingNote.created_at.desc())
        .limit(100)
        .all()
    )
    return {"notes": [_serialize(m) for m in rows]}


@router.post("/transcribe")
async def transcribe(
    title: str = Form("Meeting"),
    transcript: Optional[str] = Form(None),
    lead_id: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None),
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Create a meeting note from an uploaded audio file OR a pasted transcript."""
    text = (transcript or "").strip()
    source = "transcript"

    if not text and file is not None:
        data = await file.read()
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "file_too_large")
        try:
            text = nt.transcribe_audio(data, file.filename or "audio.mp3")
            source = "audio"
        except RuntimeError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    if not text:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "audio_or_transcript_required")

    lead = None
    if lead_id:
        lead = db.query(Lead).filter(Lead.id == lead_id, Lead.workspace_id == ctx.workspace_id).first()
        if not lead:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "lead_not_found")

    context = ""
    if lead:
        context = f"Meeting with {lead.full_name or lead.email or 'a lead'}"
    notes = nt.make_notes(text, context=context)

    mn = MeetingNote(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        lead_id=lead.id if lead else None,
        title=title.strip()[:300] or "Meeting",
        transcript=text,
        summary=notes.get("summary"),
        action_items=notes.get("action_items") or [],
        source=source,
        status="done",
    )
    db.add(mn)

    # Surface on the lead timeline as a Note + Activity.
    if lead:
        body = (notes.get("summary") or "").strip()
        items = notes.get("action_items") or []
        if items:
            body += "\n\nAction items:\n" + "\n".join(f"• {i}" for i in items)
        db.add(Note(workspace_id=ctx.workspace_id, lead_id=lead.id, author_id=ctx.user_id, body=body or "(meeting notes)"))
        db.add(
            Activity(
                workspace_id=ctx.workspace_id,
                lead_id=lead.id,
                actor_id=ctx.user_id,
                type="meeting_note",
                payload={"title": mn.title, "action_items": items},
            )
        )

    db.commit()
    db.refresh(mn)
    return _serialize(mn)


@router.delete("/{note_id}")
def delete_note(note_id: str, ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    m = db.query(MeetingNote).filter(MeetingNote.id == note_id, MeetingNote.workspace_id == ctx.workspace_id).first()
    if not m:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(m)
    db.commit()
    return {"ok": True}
