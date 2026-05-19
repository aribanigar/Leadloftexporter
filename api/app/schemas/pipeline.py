from typing import Optional

from pydantic import BaseModel


class StageBase(BaseModel):
    name: str
    color: str = "#3b82f6"
    is_won: bool = False
    is_lost: bool = False


class StageCreate(StageBase):
    position: Optional[int] = None


class StageUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    position: Optional[int] = None
    is_won: Optional[bool] = None
    is_lost: Optional[bool] = None


class StageOut(StageBase):
    id: str
    slug: str
    position: int
    lead_count: int = 0

    model_config = {"from_attributes": True}
