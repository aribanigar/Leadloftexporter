from contextlib import asynccontextmanager

import sentry_sdk
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.core.config import get_settings

_settings = get_settings()

if _settings.sentry_dsn:
    sentry_sdk.init(dsn=_settings.sentry_dsn, traces_sample_rate=0.1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


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
