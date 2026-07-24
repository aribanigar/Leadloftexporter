import logging
from contextlib import asynccontextmanager

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import get_settings

_settings = get_settings()
log = logging.getLogger(__name__)

if _settings.sentry_dsn:
    sentry_sdk.init(dsn=_settings.sentry_dsn, traces_sample_rate=0.1)


# NOTE: The old Neon keep-alive background thread (a `SELECT 1` every 4 minutes,
# 24/7) was REMOVED here. On Neon's free tier that thread kept the compute
# perpetually awake, which burned the entire monthly compute-hour quota in
# ~8 days and then locked the database out (login could no longer even read
# the user row). On Supabase the database is always-on (no per-query compute
# meter), and the external cron pinger already touches it every minute, so a
# self-ping loop is both unnecessary and harmful. `pool_pre_ping` +
# `pool_recycle` in app/core/db.py handle stale connections cleanly.


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Nothing to warm up — the connection pool lazily connects on first query
    # and `pool_pre_ping` revives any stale connection transparently.
    yield


app = FastAPI(
    title="LeadCaptura API",
    version="0.1.0",
    lifespan=lifespan,
    default_response_class=__import__("fastapi.responses", fromlist=["ORJSONResponse"]).ORJSONResponse,
)

# Always allow the extension (chrome-extension://*) AND any Vercel deployment of
# the web app (production + preview URLs), regardless of what FRONTEND_ORIGINS is
# set to on a given backend service. This makes the frontend's automatic
# backend-failover robust: whichever Render service the browser lands on will
# accept the Vercel origin even if that service's env wasn't configured with it.
# Regex-matched origins are echoed back (not "*"), so this stays compatible with
# allow_credentials=True.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.cors_origins or ["*"],
    allow_origin_regex=r"(chrome-extension://.*|https://([a-z0-9-]+\.)*vercel\.app)",
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
