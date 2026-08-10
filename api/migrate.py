"""Boot-time database bootstrap.

``0001_initial`` builds the schema with ``Base.metadata.create_all()``, which
reflects the FULL current set of models. On a brand-new database that means the
entire current schema exists after 0001, so running 0002..head would fail trying
to create tables/columns that already exist (this is what broke the first deploy
on the fresh Neon DB). So we branch:

  * Fresh DB (no ``alembic_version`` table): create everything from the models,
    then stamp the migration version to ``head`` so future migrations apply on
    top cleanly.
  * Existing DB: run ``alembic upgrade head`` normally so real migrations run.

Idempotent and safe for both cases. Invoked from the Docker CMD before uvicorn.

RETRY ON TRANSIENT CONNECTION FAILURE — added after a real incident: Supabase's
session-mode pooler caps the whole project at a small number of concurrent
clients. During a deploy, the OLD container briefly overlaps with the NEW one
(or another Render service / a burst of app traffic happens to be using every
slot at that exact instant), so this very first connection attempt — the
earliest possible moment in the container's life — can transiently fail with
"max clients reached" even though a slot frees up moments later. Previously
that raised straight out of main(), Python exited non-zero, the Docker CMD's
`&&` chain aborted before uvicorn ever started, and the WHOLE deploy was
marked failed — even though the very same code would have booted fine one or
two retries later. Retrying with backoff here turns a transient pooler
hiccup into a few extra seconds of boot time instead of a failed deploy.
"""
import time

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect
from sqlalchemy.exc import OperationalError

from app.core.db import Base, engine
import app.models  # noqa: F401  — registers every model on Base.metadata

MAX_ATTEMPTS = 6
BACKOFF_SECONDS = (2, 4, 8, 15, 25)  # 5 gaps between 6 attempts, ~54s total ceiling


def _run(cfg: Config) -> None:
    if inspect(engine).has_table("alembic_version"):
        # Established DB with migration history — apply anything pending.
        command.upgrade(cfg, "head")
    else:
        # Fresh DB — 0001 would create the whole current schema anyway, so just
        # build it from the models and mark all migrations as already applied.
        Base.metadata.create_all(bind=engine)
        command.stamp(cfg, "head")


def main() -> None:
    cfg = Config("alembic.ini")
    last_err: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            _run(cfg)
            if attempt > 1:
                print(f"[migrate] succeeded on attempt {attempt}/{MAX_ATTEMPTS}")
            return
        except OperationalError as e:
            last_err = e
            if attempt == MAX_ATTEMPTS:
                break
            wait = BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)]
            print(
                f"[migrate] DB connection attempt {attempt}/{MAX_ATTEMPTS} failed "
                f"({e.__class__.__name__}: {str(e)[:200]}) — retrying in {wait}s"
            )
            time.sleep(wait)
    # Every retry exhausted — surface the real error so a GENUINE outage still
    # fails the deploy loudly instead of hanging forever.
    raise last_err


if __name__ == "__main__":
    main()
