"""Google Sheets connections — recipient source + last-contacted write-back
for Campaigns. See services/google_sheets.py for the actual Sheets API
calls (all auth/quota concerns live there); this router is CRUD + wiring
only, following the same request/response shape as templates.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import AuthContext, get_workspace_context
from app.models import SheetConnection, SheetTab
from app.services import google_sheets as sheets_svc

router = APIRouter(prefix="/sheets", tags=["sheets"])


def _own_connection(db: Session, ctx: AuthContext, connection_id: str) -> SheetConnection:
    row = (
        db.query(SheetConnection)
        .filter(SheetConnection.id == connection_id, SheetConnection.workspace_id == ctx.workspace_id)
        .first()
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    return row


def _tab_dict(t: SheetTab) -> dict:
    return {
        "id": t.id,
        "connection_id": t.connection_id,
        "gid": t.gid,
        "title": t.title,
        "email_column": t.email_column,
        "tracking_column": t.tracking_column,
        "header_row": t.header_row,
        "row_count": t.row_count,
        "last_synced_at": t.last_synced_at,
    }


def _connection_dict(c: SheetConnection, db: Session) -> dict:
    tabs = db.query(SheetTab).filter(SheetTab.connection_id == c.id).order_by(SheetTab.created_at.asc()).all()
    return {
        "id": c.id,
        "label": c.label,
        "sheet_url": c.sheet_url,
        "spreadsheet_id": c.spreadsheet_id,
        "status": c.status,
        "last_error": c.last_error,
        "tabs": [_tab_dict(t) for t in tabs],
    }


@router.get("/service-account-email")
def get_service_account_email():
    """The address to show the user so they know who to share a sheet with."""
    return {"email": sheets_svc.service_account_email()}


@router.get("/connections")
def list_connections(ctx: AuthContext = Depends(get_workspace_context), db: Session = Depends(get_db)):
    rows = (
        db.query(SheetConnection)
        .filter(SheetConnection.workspace_id == ctx.workspace_id)
        .order_by(SheetConnection.created_at.desc())
        .all()
    )
    return [_connection_dict(c, db) for c in rows]


def _auto_configure_tab(db: Session, connection: SheetConnection, gid: str, title: str) -> None:
    """Best-effort equivalent of create_tab() for a tab whose email column
    can be guessed — used right after a connection is created so the user
    doesn't have to click through "Configure sheets" for the common case of
    a sheet with a plain "email" header. Silently skips a tab that has no
    rows yet or no detectable email column (e.g. a notes/summary tab) —
    those stay available for manual "Configure sheets" setup, unchanged."""
    try:
        headers, rows = sheets_svc.fetch_rows(connection.spreadsheet_id, gid)
        guessed = sheets_svc.find_header_column(headers, "email")
        if guessed is None:
            return
        tracking_column = "Last Contacted"
        sheets_svc.ensure_tracking_column(connection.spreadsheet_id, gid, tracking_column)
    except sheets_svc.SheetAccessError:
        return
    db.add(SheetTab(
        connection_id=connection.id,
        gid=gid,
        title=title,
        email_column=headers[guessed],
        tracking_column=tracking_column,
        row_count=len(rows),
    ))


@router.post("/connections", status_code=status.HTTP_201_CREATED)
def create_connection(
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    label = (body.get("label") or "").strip()
    sheet_url = (body.get("sheet_url") or "").strip()
    if not label or not sheet_url:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "label_and_sheet_url_required")
    try:
        spreadsheet_id = sheets_svc.parse_spreadsheet_id(sheet_url)
        tabs = sheets_svc.list_tabs(spreadsheet_id)  # verify access now, fail fast with a clear message
    except sheets_svc.SheetAccessError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    c = SheetConnection(
        workspace_id=ctx.workspace_id,
        user_id=ctx.user_id,
        label=label,
        sheet_url=sheet_url,
        spreadsheet_id=spreadsheet_id,
        status="active",
    )
    db.add(c)
    db.flush()  # assigns c.id, needed by SheetTab rows below

    # Auto-configure every tab we can (has a detectable email column) so
    # connecting a sheet is a single step — no separate "pick a tab, map
    # columns" click-through for the common case.
    for t in tabs:
        _auto_configure_tab(db, c, t["gid"], t["title"])

    db.commit()
    db.refresh(c)
    return _connection_dict(c, db)


@router.delete("/connections/{connection_id}")
def delete_connection(
    connection_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_connection(db, ctx, connection_id)
    db.delete(c)
    db.commit()
    return {"ok": True}


@router.get("/connections/{connection_id}/tabs/available")
def list_available_tabs(
    connection_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Live list of every tab in the workbook, each flagged with whether it's
    already configured — powers the "pick a tab" step in the UI."""
    c = _own_connection(db, ctx, connection_id)
    try:
        live = sheets_svc.list_tabs(c.spreadsheet_id)
    except sheets_svc.SheetAccessError as exc:
        c.status = "error"
        c.last_error = str(exc)
        db.commit()
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    configured_gids = {
        t.gid for t in db.query(SheetTab).filter(SheetTab.connection_id == c.id)
    }
    if c.status != "active":
        c.status = "active"
        c.last_error = None
        db.commit()
    return [{**t, "configured": t["gid"] in configured_gids} for t in live]


@router.get("/connections/{connection_id}/tabs/{gid}/preview")
def preview_tab(
    connection_id: str,
    gid: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    """Headers + first 10 rows, for the field-mapping confirmation step
    before a tab is actually saved as a SheetTab."""
    c = _own_connection(db, ctx, connection_id)
    try:
        headers, rows = sheets_svc.fetch_rows(c.spreadsheet_id, gid)
    except sheets_svc.SheetAccessError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    guessed_email_col = sheets_svc.find_header_column(headers, "email")
    return {
        "headers": headers,
        "rows": rows[:10],
        "row_count": len(rows),
        "guessed_email_column": headers[guessed_email_col] if guessed_email_col is not None else None,
    }


@router.post("/connections/{connection_id}/tabs", status_code=status.HTTP_201_CREATED)
def create_tab(
    connection_id: str,
    body: dict,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_connection(db, ctx, connection_id)
    gid = str(body.get("gid") or "").strip()
    title = (body.get("title") or "").strip()
    if not gid or not title:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "gid_and_title_required")

    try:
        headers, rows = sheets_svc.fetch_rows(c.spreadsheet_id, gid)
    except sheets_svc.SheetAccessError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    email_column = (body.get("email_column") or "").strip()
    if not email_column:
        guessed = sheets_svc.find_header_column(headers, "email")
        if guessed is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                {"error": "no_email_column_found", "headers": headers},
            )
        email_column = headers[guessed]

    tracking_column = (body.get("tracking_column") or "Last Contacted").strip()
    try:
        sheets_svc.ensure_tracking_column(c.spreadsheet_id, gid, tracking_column)
    except sheets_svc.SheetAccessError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    t = SheetTab(
        connection_id=c.id,
        gid=gid,
        title=title,
        email_column=email_column,
        tracking_column=tracking_column,
        row_count=len(rows),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _tab_dict(t)


@router.delete("/connections/{connection_id}/tabs/{tab_id}")
def delete_tab(
    connection_id: str,
    tab_id: str,
    ctx: AuthContext = Depends(get_workspace_context),
    db: Session = Depends(get_db),
):
    c = _own_connection(db, ctx, connection_id)
    t = db.query(SheetTab).filter(SheetTab.id == tab_id, SheetTab.connection_id == c.id).first()
    if not t:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not_found")
    db.delete(t)
    db.commit()
    return {"ok": True}
