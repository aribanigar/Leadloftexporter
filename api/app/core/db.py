from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.core.config import get_settings

_settings = get_settings()

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
    _settings.database_url,
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
