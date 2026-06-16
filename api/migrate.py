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
"""
from alembic import command
from alembic.config import Config
from sqlalchemy import inspect

from app.core.db import Base, engine
import app.models  # noqa: F401  — registers every model on Base.metadata


def main() -> None:
    cfg = Config("alembic.ini")
    if inspect(engine).has_table("alembic_version"):
        # Established DB with migration history — apply anything pending.
        command.upgrade(cfg, "head")
    else:
        # Fresh DB — 0001 would create the whole current schema anyway, so just
        # build it from the models and mark all migrations as already applied.
        Base.metadata.create_all(bind=engine)
        command.stamp(cfg, "head")


if __name__ == "__main__":
    main()
