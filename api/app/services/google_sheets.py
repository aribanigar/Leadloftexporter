"""Google Sheets access for Campaigns' "import recipients from a sheet, then
write the last-emailed date back" feature.

AUTH: a single service account, not OAuth. The user shares each sheet with
the service account's email (from the JSON key's "client_email") the same
way they'd share it with a colleague. This avoids building and maintaining
an OAuth consent-screen + refresh-token subsystem for something that only
this backend ever touches — see config.py:google_service_account_json.

QUOTA: Google Sheets API allows ~60 read/write requests per minute per
project. Every function here does AT MOST ONE API call, and the write path
(write_tracking_values) is explicitly a single batchUpdate for however many
rows changed, never one call per row — see api/app/workers/tasks.py's
sync_sheet_tracking, which is the only caller that writes at any volume.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Optional

from app.core.config import get_settings


class SheetAccessError(Exception):
    """Raised for any Sheets API failure the caller should show to the user
    (no access, sheet/tab not found, malformed URL, credentials missing)."""


_SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]+)")


def parse_spreadsheet_id(url: str) -> str:
    """Extract the spreadsheet id from any Google Sheets URL shape
    (…/d/<id>/edit#gid=0, …/d/<id>/edit?usp=sharing, or a bare id)."""
    s = (url or "").strip()
    m = _SPREADSHEET_ID_RE.search(s)
    if m:
        return m.group(1)
    # Already a bare id (no slashes, no spaces) — accept as-is.
    if s and "/" not in s and " " not in s:
        return s
    raise SheetAccessError("Could not find a spreadsheet id in that URL.")


@lru_cache(maxsize=1)
def _service_account_email() -> Optional[str]:
    raw = get_settings().google_service_account_json
    if not raw:
        return None
    try:
        return json.loads(raw).get("client_email")
    except Exception:  # noqa: BLE001
        return None


def service_account_email() -> Optional[str]:
    """The address to tell users to share their sheet with. None if the
    server-side credential isn't configured at all."""
    return _service_account_email()


def _client():
    """A Sheets API v4 client authorized as the service account. Raises
    SheetAccessError (not a raw exception) if the credential is missing or
    malformed, so route handlers can surface one clean message."""
    raw = get_settings().google_service_account_json
    if not raw:
        raise SheetAccessError(
            "Google Sheets isn't configured on this server yet "
            "(GOOGLE_SERVICE_ACCOUNT_JSON is unset)."
        )
    try:
        from google.oauth2.service_account import Credentials
        from googleapiclient.discovery import build

        info = json.loads(raw)
        creds = Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/spreadsheets"]
        )
        return build("sheets", "v4", credentials=creds, cache_discovery=False)
    except SheetAccessError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise SheetAccessError(f"Couldn't set up Google Sheets access: {exc}") from exc


def _raise_for_http_error(exc: Exception, spreadsheet_id: str) -> None:
    """googleapiclient raises HttpError with a .resp.status — translate the
    common cases into a message that tells the user exactly what to do."""
    status = getattr(getattr(exc, "resp", None), "status", None)
    email = _service_account_email() or "the service account"
    if status == 403:
        raise SheetAccessError(
            f"No access to this sheet. Share it with {email} (as Editor, so "
            "the tracking column can be written) and try again."
        ) from exc
    if status == 404:
        raise SheetAccessError("That spreadsheet wasn't found. Check the URL.") from exc
    raise SheetAccessError(f"Google Sheets error: {exc}") from exc


def list_tabs(spreadsheet_id: str) -> list[dict]:
    """[{gid, title}, ...] for every tab in the workbook."""
    svc = _client()
    try:
        meta = svc.spreadsheets().get(
            spreadsheetId=spreadsheet_id, fields="sheets.properties"
        ).execute()
    except SheetAccessError:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_for_http_error(exc, spreadsheet_id)
    return [
        {"gid": str(s["properties"]["sheetId"]), "title": s["properties"]["title"]}
        for s in meta.get("sheets", [])
    ]


def _tab_title(spreadsheet_id: str, gid: str) -> str:
    for t in list_tabs(spreadsheet_id):
        if t["gid"] == str(gid):
            return t["title"]
    raise SheetAccessError("That tab no longer exists in the spreadsheet.")


def fetch_rows(
    spreadsheet_id: str, gid: str, header_row: int = 1
) -> tuple[list[str], list[list[str]]]:
    """(headers, rows) — rows are raw string values below the header row,
    padded/truncated to len(headers) so callers can zip() safely."""
    title = _tab_title(spreadsheet_id, gid)
    svc = _client()
    rng = f"'{title}'!A{header_row}:ZZ"
    try:
        res = svc.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id, range=rng
        ).execute()
    except SheetAccessError:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_for_http_error(exc, spreadsheet_id)
    values = res.get("values", [])
    if not values:
        return [], []
    headers = [h.strip() for h in values[0]]
    rows = []
    for r in values[1:]:
        row = list(r) + [""] * (len(headers) - len(r))
        rows.append(row[: len(headers)])
    return headers, rows


def _col_letter(idx0: int) -> str:
    """0-indexed column number -> A1 letter(s)."""
    n = idx0 + 1
    letters = ""
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def find_header_column(headers: list[str], header_name: str) -> Optional[int]:
    """Case-insensitive exact match. Returns the 0-indexed column, or None."""
    target = (header_name or "").strip().lower()
    for i, h in enumerate(headers):
        if h.strip().lower() == target:
            return i
    return None


def ensure_tracking_column(spreadsheet_id: str, gid: str, tracking_header: str, header_row: int = 1) -> int:
    """Make sure `tracking_header` exists in the header row; add it as the
    next empty column if not. Returns its 0-indexed column. One API call in
    the common case (header already present), two if it has to be added."""
    headers, _ = fetch_rows(spreadsheet_id, gid, header_row)
    existing = find_header_column(headers, tracking_header)
    if existing is not None:
        return existing
    title = _tab_title(spreadsheet_id, gid)
    col_idx = len(headers)
    svc = _client()
    try:
        svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=f"'{title}'!{_col_letter(col_idx)}{header_row}",
            valueInputOption="RAW",
            body={"values": [[tracking_header]]},
        ).execute()
    except SheetAccessError:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_for_http_error(exc, spreadsheet_id)
    return col_idx


def write_tracking_values(
    spreadsheet_id: str,
    gid: str,
    email_column: str,
    tracking_column: str,
    updates: dict[str, str],
    header_row: int = 1,
) -> int:
    """Write `updates` ({email: date_string}) into `tracking_column` for
    whichever rows currently hold a matching email in `email_column` — one
    email may appear in more than one row; every match gets written. A
    SINGLE batchUpdate call regardless of how many rows match, so this stays
    well under Sheets' per-minute quota even for a large sync batch. Returns
    the number of rows actually written (an email in `updates` with no
    matching row is silently skipped, not an error — the sheet may have
    been edited since the recipient was imported)."""
    if not updates:
        return 0
    headers, rows = fetch_rows(spreadsheet_id, gid, header_row)
    email_idx = find_header_column(headers, email_column)
    if email_idx is None:
        raise SheetAccessError(f'Email column "{email_column}" not found in the sheet header row.')
    track_idx = ensure_tracking_column(spreadsheet_id, gid, tracking_column, header_row)
    # ensure_tracking_column may have re-fetched a slightly newer header, but
    # row data doesn't change from adding a column, so `rows` stays valid.

    title = _tab_title(spreadsheet_id, gid)
    col_letter = _col_letter(track_idx)
    data = []
    written = 0
    lower_updates = {k.strip().lower(): v for k, v in updates.items()}
    for i, row in enumerate(rows):
        email = (row[email_idx] if email_idx < len(row) else "").strip().lower()
        if email and email in lower_updates:
            sheet_row = header_row + 1 + i  # 1-indexed, first data row is header_row+1
            data.append({
                "range": f"'{title}'!{col_letter}{sheet_row}",
                "values": [[lower_updates[email]]],
            })
            written += 1
    if not data:
        return 0
    svc = _client()
    try:
        svc.spreadsheets().values().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"valueInputOption": "RAW", "data": data},
        ).execute()
    except SheetAccessError:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_for_http_error(exc, spreadsheet_id)
    return written
