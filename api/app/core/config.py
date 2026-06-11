from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    app_env: str = "development"
    app_name: str = "LeadCaptura"

    secret_key: str = Field(default="dev-secret-change-me")
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24 * 30

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/leadcaptura"
    redis_url: str = "redis://localhost:6379/0"

    frontend_origins: str = "http://localhost:3000"

    gmail_client_id: str = ""
    gmail_client_secret: str = ""
    gmail_redirect_uri: str = "http://localhost:3000/api/integrations/gmail/callback"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-4-7"
    anthropic_fast_model: str = "claude-haiku-4-5"

    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""

    sentry_dsn: str = ""

    # ---- SMTP relay (Render → Vercel egress) ----
    # Render's free + starter tiers block outbound SMTP ports 25/465/587 so
    # `aiosmtplib.send()` to e.g. smtp.hostinger.com just times out. The
    # relay is a tiny Next.js endpoint on Vercel (src/app/api/smtp-relay)
    # that performs the SMTP send from Vercel's network instead — Vercel
    # doesn't block outbound SMTP. `email_sender.py` falls back to it
    # automatically, and `integrations.py:smtp_connect` uses it to verify
    # creds on save. Both URL and secret default to sensible auto-derived
    # values so no extra env vars are required for the default deploy.
    # Hardcoded to the Vercel production URL so SMTP relay works zero-config.
    # Override via SMTP_RELAY_URL env var only if the domain changes.
    smtp_relay_url: str = "https://leadloftexporter.vercel.app/api/smtp-relay"
    smtp_relay_secret: str = ""

    # Public, internet-reachable base URL of THIS backend. Used to build
    # absolute open-/click-tracking URLs embedded in campaign emails — they
    # must resolve from the recipient's mail client, so a relative path or
    # localhost won't do. Defaults to the production Render host.
    public_api_url: str = "https://leadloftexporter.onrender.com"

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]

    @property
    def resolved_smtp_relay_url(self) -> str:
        """Use the explicitly-configured relay URL, or derive '<first-frontend>/api/smtp-relay'."""
        if self.smtp_relay_url:
            return self.smtp_relay_url.rstrip("/")
        origins = self.cors_origins
        for o in origins:
            if "localhost" not in o and "127.0.0.1" not in o:
                return o.rstrip("/") + "/api/smtp-relay"
        if origins:
            return origins[0].rstrip("/") + "/api/smtp-relay"
        return ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
