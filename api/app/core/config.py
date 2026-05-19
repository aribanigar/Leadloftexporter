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

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.frontend_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
