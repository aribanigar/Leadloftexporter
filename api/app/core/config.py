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

    # ---- Google Calendar OAuth ----
    # A real OAuth2 web client (Google Cloud Console → Credentials) with the
    # Calendar API enabled. Unlike Gmail (which uses an App Password + SMTP),
    # calendar sync needs a true authorization-code flow so we get a
    # refresh_token and can read free/busy + write events on the user's behalf.
    # The same Google Cloud OAuth client can serve both Gmail and Calendar, but
    # the consent screen must list the Calendar scopes. Set these in the
    # backend env (Render). Leave the redirect blank to auto-derive it from
    # public_api_url → "<public_api_url>/api/v1/calendar/oauth/google/callback".
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""

    # ---- Company Finder (Google Places API New) ----
    # Server-wide fallback key for Company Finder's business discovery. A
    # workspace can also set its own key in the UI (Workspace.settings
    # ["company_finder"]["google_api_key"]), which takes precedence. The key
    # needs "Places API (New)" enabled with billing on.
    google_places_api_key: str = ""

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-4-7"
    anthropic_fast_model: str = "claude-haiku-4-5"

    # ---- Meeting Notetaker transcription ----
    # Audio → text needs a speech-to-text service (Claude can't transcribe
    # audio). Default to OpenAI Whisper (POST /v1/audio/transcriptions,
    # model whisper-1). Set OPENAI_API_KEY to enable MP3/audio uploads; without
    # it the notetaker still works from a pasted transcript. Summaries always
    # use Claude (anthropic_api_key) with a deterministic fallback.
    openai_api_key: str = ""
    whisper_model: str = "whisper-1"

    # Shared secret for the external-cron trigger endpoint (/api/v1/cron/run).
    # Lets a free HTTP cron service (e.g. cron-job.org) drive the periodic
    # tasks (deliver reminders, daily agendas, drain emails) without a paid
    # Celery worker. The ping also keeps a free web service awake.
    cron_secret: str = ""

    # Shared secret for the Content Hub ingest endpoint (POST /content-hub/ingest).
    # The daily content routine can't reach the DB directly (Supabase REST is
    # egress-restricted; direct Postgres is blocked in the routine sandbox), but
    # it CAN reach this backend over HTTPS — and the backend's own pooled DB
    # connection works. Set the SAME value here (backend env) and in the routine
    # so it can POST generated assets and we write them via SQLAlchemy. Empty =
    # the ingest endpoint is disabled (503).
    content_ingest_token: str = ""

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
    smtp_relay_url: str = "https://leadloftexporter-neon.vercel.app/api/smtp-relay"
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
    def resolved_google_redirect_uri(self) -> str:
        """Backend callback URL for the Google Calendar OAuth flow.

        Uses an explicit GOOGLE_REDIRECT_URI if set, else derives it from the
        public backend URL. This exact value must be added as an "Authorized
        redirect URI" on the Google Cloud OAuth client.
        """
        if self.google_redirect_uri:
            return self.google_redirect_uri.rstrip("/")
        return self.public_api_url.rstrip("/") + "/api/v1/calendar/oauth/google/callback"

    @property
    def primary_frontend_origin(self) -> str:
        """Best public frontend origin to redirect the browser back to after OAuth."""
        origins = self.cors_origins
        for o in origins:
            if "localhost" not in o and "127.0.0.1" not in o:
                return o.rstrip("/")
        return (origins[0].rstrip("/") if origins else "http://localhost:3000")

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
