from typing import Optional

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    workspace_name: Optional[str] = None
    # Admin-issued invite code (see admin_access.py:invite_new_user). Optional
    # here at the schema level so the error path can be a clear custom
    # "license_key_required" detail rather than a generic 422 — enforcement
    # lives in auth.py:register.
    license_key: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    avatar_url: Optional[str] = None

    model_config = {"from_attributes": True}


class WorkspaceContext(BaseModel):
    id: str
    name: str
    slug: str
    role: str

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
    workspaces: list[WorkspaceContext]
    current_workspace_id: Optional[str] = None
    # Only ever set once, in auth.py:register's response, right after a
    # freshly-claimed invite also auto-issues the new user their own API
    # key — shown once so they can paste it (alongside the same license key
    # they just registered with) into the extension's Options page. Always
    # None from /auth/login and /auth/me.
    issued_api_key: Optional[str] = None
