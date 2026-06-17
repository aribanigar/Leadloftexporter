import logging
import threading
import time
from contextlib import asynccontextmanager

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.db import engine

_settings = get_settings()
log = logging.getLogger(__name__)

if _settings.sentry_dsn:
    sentry_sdk.init(dsn=_settings.sentry_dsn, traces_sample_rate=0.1)


# ── Neon keep-alive ───────────────────────────────────────────────────────
# Neon's free tier auto-suspends the compute after ~5 minutes idle. First
# query after a sleep takes 2-5 seconds — long enough that login feels
# broken. This background thread runs `SELECT 1` every 4 minutes from
# WITHIN the API process, so Neon never sees idle time. The thread is a
# daemon so it dies with the worker, never blocks shutdown. Failures are
# logged and swallowed — a missed ping is not fatal, the next one will
# wake the DB anyway.
_KEEPALIVE_INTERVAL_S = 240   # 4 minutes
_keepalive_stop = threading.Event()


def _keepalive_loop() -> None:
    # First iteration fires immediately (no wait) so the pool warms ASAP
    # after boot without blocking the lifespan / first HTTP request.
    while not _keepalive_stop.is_set():
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
        except Exception as exc:  # noqa: BLE001
            log.warning("keepalive ping failed: %s", exc)
        _keepalive_stop.wait(_KEEPALIVE_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Kick the keep-alive thread off immediately and let IT do the initial
    # warm-up. Doing the `SELECT 1` inline here used to block startup for 5–10s
    # whenever Neon was suspended at boot, which meant the server wasn't
    # accepting requests during that window — login appeared to hang on
    # Render Free-tier cold starts.
    t = threading.Thread(target=_keepalive_loop, name="db-keepalive", daemon=True)
    t.start()
    try:
        yield
    finally:
        _keepalive_stop.set()


app = FastAPI(
    title="LeadCaptura API",
    version="0.1.0",
    lifespan=lifespan,
    default_response_class=__import__("fastapi.responses", fromlist=["ORJSONResponse"]).ORJSONResponse,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins or ["*"],
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "leadcaptura-api"}


@app.get("/")
def root() -> dict:
    return {"name": "LeadCaptura", "version": "0.1.0"}
