from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import Lead, PipelineStage
from app.schemas import StageCreate, StageOut, StageUpdate

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _slugify(name: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in name.lower()).strip("_")


@router.get("/stages", response_model=list[StageOut])
def list_stages(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    stages = (
        db.query(PipelineStage)
        .filter(PipelineStage.workspace_id == ctx.workspace_id)
        .order_by(PipelineStage.position.asc())
        .all()
    )
    counts = dict(
        db.query(Lead.stage_id, func.count(Lead.id))
        .filter(Lead.workspace_id == ctx.workspace_id)
        .group_by(Lead.stage_id)
        .all()
    )
    out = []
    for s in stages:
        data = StageOut.model_validate(s)
        data.lead_count = counts.get(s.id, 0)
        out.append(data)
    return out


@router.post("/stages", response_model=StageOut, status_code=status.HTTP_201_CREATED)
def create_stage(
    body: StageCreate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    position = body.position
    if position is None:
        max_pos = (
            db.query(func.max(PipelineStage.position))
            .filter(PipelineStage.workspace_id == ctx.workspace_id)
            .scalar()
            or 0
        )
        position = max_pos + 1
    stage = PipelineStage(
        workspace_id=ctx.workspace_id,
        name=body.name,
        slug=_slugify(body.name),
        color=body.color,
        is_won=body.is_won,
        is_lost=body.is_lost,
        position=position,
    )
    db.add(stage)
    db.commit()
    db.refresh(stage)
    return StageOut.model_validate(stage)


@router.patch("/stages/{stage_id}", response_model=StageOut)
def update_stage(
    stage_id: str,
    body: StageUpdate,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    stage = (
        db.query(PipelineStage)
        .filter(PipelineStage.id == stage_id, PipelineStage.workspace_id == ctx.workspace_id)
        .first()
    )
    if not stage:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(stage, k, v)
    db.commit()
    db.refresh(stage)
    return StageOut.model_validate(stage)


@router.delete("/stages/{stage_id}")
def delete_stage(
    stage_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    stage = (
        db.query(PipelineStage)
        .filter(PipelineStage.id == stage_id, PipelineStage.workspace_id == ctx.workspace_id)
        .first()
    )
    if not stage:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.query(Lead).filter(Lead.stage_id == stage_id).update({Lead.stage_id: None})
    db.delete(stage)
    db.commit()
    return {"ok": True}


@router.post("/stages/reorder")
def reorder_stages(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """body = {"order": ["stage_id_1", "stage_id_2", ...]}"""
    ids: list[str] = body.get("order", [])
    for i, sid in enumerate(ids):
        db.query(PipelineStage).filter(
            PipelineStage.id == sid, PipelineStage.workspace_id == ctx.workspace_id
        ).update({PipelineStage.position: i})
    db.commit()
    return {"ok": True}
