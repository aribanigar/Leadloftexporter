from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.schemas.lead import LeadIngest


class ExtensionSyncProfile(LeadIngest):
    pass


class ExtensionSyncSearch(BaseModel):
    """Bulk sync of LinkedIn search / Sales Navigator result page."""

    page_url: str
    captured_at: datetime
    profiles: list[LeadIngest] = Field(default_factory=list)


class ExtensionJobOut(BaseModel):
    id: str
    kind: str
    payload: dict[str, Any]
    lead_id: Optional[str] = None
    not_before: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ExtensionJobClaim(BaseModel):
    limit: int = 1


class ExtensionJobResult(BaseModel):
    status: str  # done|failed|skipped
    result: dict[str, Any] = Field(default_factory=dict)
    error: Optional[str] = None
