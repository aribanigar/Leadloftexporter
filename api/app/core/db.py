from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings

_settings = get_settings()


def _normalize_db_url(url: str) -> str:
    """Coerce the SQLAlchemy URL to the psycopg3 driver no matter how the
    DATABASE_URL env var is written.

    We only ship `psycopg[binary]` (psycopg3) in requirements.txt — psycopg2
    is NOT installed. If `DATABASE_URL` arrives with the bare `postgresql://`
    or `postgres://` scheme (which is what Supabase / Neon dashboards copy by
    default), SQLAlchemy tries to load psycopg2 and the import dies with
    `ModuleNotFoundError: No module named 'psycopg2'`. This shim rewrites
    every Postgres URL to `postgresql+psycopg://…` so the right driver is
    picked, eliminating an entire class of deploy-time failures.

    Idempotent: a URL already on `postgresql+psycopg://` passes through
    unchanged.
    """
    if not url:
        return url
    if url.startswith("postgresql+psycopg://"):
        return url
    if url.startswith("postgresql+psycopg2://"):
        # Force-replace the psycopg2 dialect with psycopg3 — psycopg2 isn't
        # installed in this image.
        return "postgresql+psycopg://" + url[len("postgresql+psycopg2://"):]
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://"):]
    if url.startswith("postgres://"):  # Heroku-style alias
        return "postgresql+psycopg://" + url[len("postgres://"):]
    return url


# Engine tuned for Supabase's connection pooler (Supavisor). Render's
# outbound traffic is IPv4-only, and Supabase's *direct* connection
# (db.<ref>.supabase.co:5432) is IPv6-only, so DATABASE_URL must point at the
# Session-mode pooler host (aws-0-<region>.pooler.supabase.com:5432). The
# pooler silently drops connections that sit idle for a while, so:
#   - pool_pre_ping  → SQLAlchemy checks a connection is alive before handing
#     it out and transparently reconnects if the pooler dropped it.
#   - pool_recycle   → proactively retire any connection older than 30 min so
#     we never even reach for one the pooler has already culled.
# pool_size is kept modest because the Supabase free tier caps total server
# connections; 10 + 20 overflow = 30 max from one Render instance is safe.
engine = create_engine(
    _normalize_db_url(_settings.database_url),
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    pool_recycle=1800,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
