"""Google Calendar integration — real OAuth2 (authorization-code) flow plus
free/busy reads and event read/write.

Unlike Gmail in this codebase (App Password + SMTP), calendar sync needs a true
OAuth flow so we obtain a long-lived ``refresh_token`` and can act on the user's
behalf in the background (the daily-agenda + reminder beat jobs run with no user
request in flight). Tokens are stored on a ``ConnectedAccount`` row with
``provider="google_calendar"``; this module refreshes the access token in place
when it has expired and writes the new value back.

The same Google Cloud OAuth client can serve Gmail too, but the consent screen
must include the Calendar scope below.
"""
from __future__ import annotations

import logging
import os

# Google returns scopes in a normalized order and may include scopes the account
# previously granted to this OAuth client (e.g. business.manage). oauthlib then
# raises "Scope has changed" and the token exchange fails. Relaxing this check is
# the documented, correct way to accept Google's returned scope set. Must be set
# before google-auth-oauthlib / oauthlib validate the token response.
os.environ.setdefault("OAUTHLIB_RELAX_TOKEN_SCOPE", "1")
from datetime import datetime, timezone
from typing import Optional

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import ConnectedAccount

log = logging.getLogger(__name__)
_settings = get_settings()

# Full calendar scope covers calendarList, freebusy, and event read/write.
# userinfo.email lets us label the connection with the Google account address.
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/calendar",
]

PROVIDER = "google_calendar"


def resolve_client(client_id: Optional[str] = None, client_secret: Optional[str] = None) -> tuple[str, str]:
    """Pick the OAuth client to use: an explicit (per-workspace, BYO) pair, else
    the server env vars. Lets users self-configure Google from the UI without
    any backend env vars."""
    return (client_id or _settings.google_client_id or "", client_secret or _settings.google_client_secret or "")


def is_configured(client_id: Optional[str] = None, client_secret: Optional[str] = None) -> bool:
    cid, csec = resolve_client(client_id, client_secret)
    return bool(cid and csec)


def _client_config(client_id: str, client_secret: str) -> dict:
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [_settings.resolved_google_redirect_uri],
        }
    }


def build_consent_url(state: str, *, client_id: str, client_secret: str) -> str:
    """Return the Google consent-screen URL to send the user to.

    ``access_type=offline`` + ``prompt=consent`` guarantees a refresh_token even
    on re-auth, which the background jobs depend on.
    """
    flow = Flow.from_client_config(
        _client_config(client_id, client_secret), scopes=SCOPES, redirect_uri=_settings.resolved_google_redirect_uri
    )
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        # Do NOT include previously-granted scopes — that pulls unrelated scopes
        # (e.g. business.manage) into the token and trips oauthlib's scope check.
        include_granted_scopes="false",
        prompt="consent",
        state=state,
    )
    return auth_url


def exchange_code(code: str, *, client_id: str, client_secret: str) -> dict:
    """Trade the authorization code for tokens. Returns a dict with
    access_token / refresh_token / expiry (aware UTC) / email."""
    flow = Flow.from_client_config(
        _client_config(client_id, client_secret), scopes=SCOPES, redirect_uri=_settings.resolved_google_redirect_uri
    )
    flow.fetch_token(code=code)
    creds = flow.credentials
    email = ""
    try:
        info = build("oauth2", "v2", credentials=creds, cache_discovery=False).userinfo().get().execute()
        email = info.get("email", "") or ""
    except Exception as exc:  # noqa: BLE001
        log.warning("google userinfo lookup failed: %s", exc)
    return {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "expiry": _aware(creds.expiry),
        "email": email,
    }


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def ensure_credentials(db: Session, account: ConnectedAccount) -> Optional[Credentials]:
    """Build live Google Credentials for an account, refreshing + persisting the
    access token if it has expired. Returns None if the account can't be used
    (no refresh token / not configured)."""
    if account.provider != PROVIDER or not account.refresh_token:
        return None
    # Use the OAuth client this account was connected with (BYO per-workspace),
    # falling back to server env vars.
    cfg = account.config or {}
    client_id, client_secret = resolve_client(cfg.get("oauth_client_id"), cfg.get("oauth_client_secret"))
    if not (client_id and client_secret):
        return None
    creds = Credentials(
        token=account.access_token,
        refresh_token=account.refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=SCOPES,
    )
    expired = account.token_expires_at is None or _aware(account.token_expires_at) <= datetime.now(timezone.utc)
    if expired or not account.access_token:
        try:
            creds.refresh(Request())
        except Exception as exc:  # noqa: BLE001
            log.warning("google token refresh failed for account %s: %s", account.id, exc)
            account.status = "inactive"
            db.commit()
            return None
        account.access_token = creds.token
        account.token_expires_at = _aware(creds.expiry)
        account.status = "active"
        db.commit()
    return creds


def _service(creds: Credentials):
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def list_calendars(creds: Credentials) -> list[dict]:
    """Return the user's calendars as [{id, name, primary, access_role}]."""
    svc = _service(creds)
    out: list[dict] = []
    page_token = None
    while True:
        resp = svc.calendarList().list(pageToken=page_token, maxResults=250).execute()
        for item in resp.get("items", []):
            out.append(
                {
                    "id": item.get("id"),
                    "name": item.get("summaryOverride") or item.get("summary") or item.get("id"),
                    "primary": bool(item.get("primary")),
                    "access_role": item.get("accessRole"),
                    "background_color": item.get("backgroundColor"),
                }
            )
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return out


def freebusy(creds: Credentials, calendar_ids: list[str], time_min: datetime, time_max: datetime) -> list[dict]:
    """Merged busy intervals across the given calendars as
    [{calendar_id, start, end}] (RFC3339 strings), for availability."""
    if not calendar_ids:
        return []
    svc = _service(creds)
    body = {
        "timeMin": _rfc3339(time_min),
        "timeMax": _rfc3339(time_max),
        "items": [{"id": cid} for cid in calendar_ids],
    }
    resp = svc.freebusy().query(body=body).execute()
    out: list[dict] = []
    for cid, cal in (resp.get("calendars") or {}).items():
        for b in cal.get("busy", []):
            out.append({"calendar_id": cid, "start": b.get("start"), "end": b.get("end")})
    return out


def list_events(creds: Credentials, calendar_id: str, time_min: datetime, time_max: datetime) -> list[dict]:
    """Expanded list of events on a single calendar within a window."""
    svc = _service(creds)
    out: list[dict] = []
    page_token = None
    while True:
        resp = (
            svc.events()
            .list(
                calendarId=calendar_id,
                timeMin=_rfc3339(time_min),
                timeMax=_rfc3339(time_max),
                singleEvents=True,
                orderBy="startTime",
                maxResults=250,
                pageToken=page_token,
            )
            .execute()
        )
        for ev in resp.get("items", []):
            start = ev.get("start", {})
            end = ev.get("end", {})
            out.append(
                {
                    "id": ev.get("id"),
                    "summary": ev.get("summary", ""),
                    "start": start.get("dateTime") or start.get("date"),
                    "end": end.get("dateTime") or end.get("date"),
                    "all_day": "date" in start,
                    "html_link": ev.get("htmlLink"),
                    "location": ev.get("location"),
                    "attendees": [a.get("email") for a in ev.get("attendees", []) if a.get("email")],
                }
            )
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return out


def create_event(
    creds: Credentials,
    calendar_id: str,
    *,
    summary: str,
    description: str,
    start: datetime,
    end: datetime,
    add_popup_minutes: Optional[int] = 10,
) -> dict:
    """Create a timed event. Returns {id, html_link}."""
    svc = _service(creds)
    body: dict = {
        "summary": summary[:1024],
        "description": description or "",
        "start": {"dateTime": _rfc3339(start)},
        "end": {"dateTime": _rfc3339(end)},
    }
    if add_popup_minutes is not None:
        body["reminders"] = {
            "useDefault": False,
            "overrides": [{"method": "popup", "minutes": int(add_popup_minutes)}],
        }
    ev = svc.events().insert(calendarId=calendar_id, body=body).execute()
    return {"id": ev.get("id"), "html_link": ev.get("htmlLink")}


def update_event(
    creds: Credentials,
    calendar_id: str,
    event_id: str,
    *,
    summary: Optional[str] = None,
    description: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> dict:
    svc = _service(creds)
    patch: dict = {}
    if summary is not None:
        patch["summary"] = summary[:1024]
    if description is not None:
        patch["description"] = description
    if start is not None:
        patch["start"] = {"dateTime": _rfc3339(start)}
    if end is not None:
        patch["end"] = {"dateTime": _rfc3339(end)}
    ev = svc.events().patch(calendarId=calendar_id, eventId=event_id, body=patch).execute()
    return {"id": ev.get("id"), "html_link": ev.get("htmlLink")}


def delete_event(creds: Credentials, calendar_id: str, event_id: str) -> None:
    svc = _service(creds)
    try:
        svc.events().delete(calendarId=calendar_id, eventId=event_id).execute()
    except Exception as exc:  # noqa: BLE001
        # 404/410 mean it's already gone — fine.
        log.info("delete_event ignored error for %s/%s: %s", calendar_id, event_id, exc)


def _rfc3339(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()
