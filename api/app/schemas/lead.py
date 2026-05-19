from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, EmailStr, Field


class LeadBase(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    full_name: Optional[str] = None
    title: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    location: Optional[str] = None
    headline: Optional[str] = None
    avatar_url: Optional[str] = None
    estimated_value: Optional[int] = None
    custom: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class LeadCreate(LeadBase):
    company_name: Optional[str] = None
    company_domain: Optional[str] = None
    company_website: Optional[str] = None
    stage_id: Optional[str] = None


class LeadUpdate(BaseModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    full_name: Optional[str] = None
    title: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    linkedin_url: Optional[str] = None
    location: Optional[str] = None
    headline: Optional[str] = None
    estimated_value: Optional[int] = None
    close_date: Optional[datetime] = None
    stage_id: Optional[str] = None
    owner_id: Optional[str] = None
    company_id: Optional[str] = None
    custom: Optional[dict[str, Any]] = None
    tags: Optional[list[str]] = None


class CompanyMini(BaseModel):
    id: str
    name: str
    domain: Optional[str] = None
    website: Optional[str] = None
    headcount: Optional[int] = None
    description: Optional[str] = None
    phone: Optional[str] = None

    model_config = {"from_attributes": True}


class LeadOut(LeadBase):
    id: str
    workspace_id: str
    owner_id: Optional[str] = None
    stage_id: Optional[str] = None
    company_id: Optional[str] = None
    company: Optional[CompanyMini] = None
    source: Optional[str] = None
    email_status: Optional[str] = None
    close_date: Optional[datetime] = None
    last_activity_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LeadList(BaseModel):
    items: list[LeadOut]
    total: int
    page: int
    page_size: int


class LeadIngest(BaseModel):
    """Posted by the Chrome extension after scraping a LinkedIn profile."""

    linkedin_url: str
    full_name: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    headline: Optional[str] = None
    title: Optional[str] = None
    location: Optional[str] = None
    avatar_url: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    company_name: Optional[str] = None
    company_url: Optional[str] = None
    company_domain: Optional[str] = None
    experience: list[dict[str, Any]] = Field(default_factory=list)
    education: list[dict[str, Any]] = Field(default_factory=list)
    raw: dict[str, Any] = Field(default_factory=dict)


class LeadIngestResponse(BaseModel):
    lead: LeadOut
    created: bool
