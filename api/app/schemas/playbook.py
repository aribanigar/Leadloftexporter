from typing import Any, Optional

from pydantic import BaseModel, Field


class StepBase(BaseModel):
    kind: str
    wait_days: int = 0
    wait_hours: int = 0
    config: dict[str, Any] = Field(default_factory=dict)
    template_id: Optional[str] = None


class StepUpdate(StepBase):
    position: Optional[int] = None


class StepOut(StepBase):
    id: str
    position: int

    model_config = {"from_attributes": True}


class PlaybookBase(BaseModel):
    name: str
    description: Optional[str] = None
    is_active: bool = True
    trigger: str = "manual"
    trigger_config: dict[str, Any] = Field(default_factory=dict)
    daily_enrollment_limit: int = 30
    track_opens: bool = True
    contact_unverified: bool = False
    eject_on_reply: bool = True
    fallback_to_email_domain: bool = True
    find_phone_numbers: bool = False
    on_positive_reply_stage: Optional[str] = None
    on_negative_reply_stage: Optional[str] = None
    on_no_reply_stage: Optional[str] = None


class PlaybookCreate(PlaybookBase):
    steps: list[StepBase] = Field(default_factory=list)


class PlaybookUpdate(PlaybookBase):
    steps: Optional[list[StepUpdate]] = None


class PlaybookOut(PlaybookBase):
    id: str
    steps: list[StepOut] = Field(default_factory=list)
    enrolled_count: int = 0

    model_config = {"from_attributes": True}
