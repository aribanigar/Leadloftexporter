from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Task

router = APIRouter(prefix="/tasks", tags=["tasks"])


@router.get("")
def list_tasks(
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
    status_: Optional[str] = None,
    assignee_id: Optional[str] = None,
):
    q = db.query(Task).filter(Task.workspace_id == ctx.workspace_id)
    if status_:
        q = q.filter(Task.status == status_)
    if assignee_id:
        q = q.filter(Task.assignee_id == assignee_id)
    rows = q.order_by(Task.due_at.asc().nullslast(), Task.created_at.desc()).all()
    return [
        {
            "id": t.id,
            "title": t.title,
            "notes": t.notes,
            "type": t.type,
            "status": t.status,
            "due_at": t.due_at,
            "completed_at": t.completed_at,
            "lead_id": t.lead_id,
            "assignee_id": t.assignee_id,
            "created_at": t.created_at,
        }
        for t in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_task(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = Task(
        workspace_id=ctx.workspace_id,
        title=body["title"],
        notes=body.get("notes"),
        type=body.get("type", "todo"),
        lead_id=body.get("lead_id"),
        assignee_id=body.get("assignee_id") or ctx.user_id,
        due_at=body.get("due_at"),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return {"id": t.id}


@router.patch("/{task_id}")
def update_task(
    task_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = db.query(Task).filter(Task.id == task_id, Task.workspace_id == ctx.workspace_id).first()
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    for k in ("title", "notes", "type", "status", "due_at", "lead_id", "assignee_id"):
        if k in body:
            setattr(t, k, body[k])
    if body.get("status") == "done" and not t.completed_at:
        t.completed_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.delete("/{task_id}")
def delete_task(
    task_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    t = db.query(Task).filter(Task.id == task_id, Task.workspace_id == ctx.workspace_id).first()
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(t)
    db.commit()
    return {"ok": True}
