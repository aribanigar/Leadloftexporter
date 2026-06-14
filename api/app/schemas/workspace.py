from typing import Optional

from pydantic import BaseModel


class WorkspaceCreate(BaseModel):
    name: str


class WorkspaceOut(BaseModel):
    id: str
    name: str
    slug: str
    plan: str
    settings: dict = {}

    model_config = {"from_attributes": True}


class OutreachSettings(BaseModel):
    email_sending_pattern: str = "mimic_humans"  # mimic_humans|burst
    schedule: str = "any_day"  # any_day|weekdays|custom
    time_frame_start: str = "07:00"
    time_frame_end: str = "19:00"
    timezone: str = "Asia/Calcutta"
    email_limit_per_day: int = 1_000_000  # effectively unlimited by default
    linkedin_connect_limit: int = 15
    linkedin_message_limit: int = 30
    custom_days: Optional[list[int]] = None  # 0=Mon
