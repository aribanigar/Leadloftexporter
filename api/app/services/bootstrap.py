"""Seed a brand-new workspace with default pipeline stages, fields, and saved views."""
from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import LeadField, PipelineStage, SavedView

DEFAULT_STAGES = [
    {"name": "New", "color": "#3b82f6", "is_won": False, "is_lost": False},
    {"name": "Responded", "color": "#8b5cf6", "is_won": False, "is_lost": False},
    {"name": "Interested", "color": "#06b6d4", "is_won": False, "is_lost": False},
    {"name": "Proposal Sent", "color": "#f59e0b", "is_won": False, "is_lost": False},
    {"name": "Customer", "color": "#10b981", "is_won": True, "is_lost": False},
    {"name": "Not Ready Yet", "color": "#94a3b8", "is_won": False, "is_lost": False},
    {"name": "Not Interested", "color": "#ef4444", "is_won": False, "is_lost": True},
]

DEFAULT_FIELDS = [
    {"key": "first_name", "label": "First Name", "type": "text", "is_system": True, "visible_default": True},
    {"key": "last_name", "label": "Last Name", "type": "text", "is_system": True, "visible_default": True},
    {"key": "title", "label": "Title", "type": "text", "is_system": True, "visible_default": True},
    {"key": "email", "label": "Email", "type": "text", "is_system": True, "visible_default": True},
    {"key": "phone", "label": "Phone", "type": "text", "is_system": True, "visible_default": False},
    {"key": "linkedin_url", "label": "LinkedIn", "type": "url", "is_system": True, "visible_default": True},
    {"key": "company", "label": "Company", "type": "text", "is_system": True, "visible_default": True},
    {"key": "location", "label": "Location", "type": "text", "is_system": True, "visible_default": False},
    {"key": "stage", "label": "Status", "type": "text", "is_system": True, "visible_default": True},
    {"key": "owner", "label": "Owner", "type": "text", "is_system": True, "visible_default": True},
    {"key": "close_date", "label": "Close Date", "type": "date", "is_system": True, "visible_default": True},
    {"key": "estimated_value", "label": "Deal Value", "type": "number", "is_system": True, "visible_default": True},
    {"key": "created_at", "label": "Date Created", "type": "date", "is_system": True, "visible_default": False},
    {"key": "updated_at", "label": "Date Updated", "type": "date", "is_system": True, "visible_default": False},
]

DEFAULT_VIEWS = [
    {
        "name": "all list",
        "icon": "list",
        "filters": {},
        "columns": ["full_name", "title", "company", "email", "stage", "owner", "close_date"],
        "sort": {"field": "created_at", "dir": "desc"},
    },
    {
        "name": "New",
        "icon": "sparkle",
        "filters": {"stage_slug": ["new"]},
        "columns": ["full_name", "title", "company", "stage", "owner", "created_at"],
        "sort": {"field": "created_at", "dir": "desc"},
    },
    {
        "name": "Go Follow Up",
        "icon": "alarm",
        "filters": {"no_activity_days": 7, "stage_slug": ["new", "responded"]},
        "columns": ["full_name", "title", "company", "stage", "last_activity_at"],
        "sort": {"field": "last_activity_at", "dir": "asc"},
    },
    {
        "name": "90 Day Follow Up",
        "icon": "calendar",
        "filters": {"no_activity_days": 90},
        "columns": ["full_name", "title", "company", "stage", "last_activity_at"],
        "sort": {"field": "last_activity_at", "dir": "asc"},
    },
    {
        "name": "My Deals",
        "icon": "user",
        "filters": {"mine": True},
        "columns": ["full_name", "title", "company", "stage", "estimated_value", "close_date"],
        "sort": {"field": "estimated_value", "dir": "desc"},
    },
]


def seed_workspace_defaults(db: Session, workspace_id: str) -> None:
    for i, stage in enumerate(DEFAULT_STAGES):
        db.add(
            PipelineStage(
                workspace_id=workspace_id,
                name=stage["name"],
                slug=stage["name"].lower().replace(" ", "_"),
                color=stage["color"],
                is_won=stage["is_won"],
                is_lost=stage["is_lost"],
                position=i,
            )
        )
    for i, field in enumerate(DEFAULT_FIELDS):
        db.add(
            LeadField(
                workspace_id=workspace_id,
                key=field["key"],
                label=field["label"],
                type=field["type"],
                position=i,
                is_system=field["is_system"],
                visible_default=field["visible_default"],
            )
        )
    for i, view in enumerate(DEFAULT_VIEWS):
        db.add(
            SavedView(
                workspace_id=workspace_id,
                name=view["name"],
                icon=view.get("icon"),
                filters=view["filters"],
                columns=view["columns"],
                sort=view["sort"],
                position=i,
                is_shared=True,
            )
        )
