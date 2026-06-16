FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev curl && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
COPY migrate.py ./

EXPOSE 8000

# Bootstrap the DB on boot (handles fresh DBs whose 0001 metadata.create_all
# builds the whole schema), then start the app. PORT is provided by the host
# (Railway / Render / Fly). Defaults to 8000 for local docker runs.
CMD ["sh", "-c", "python migrate.py && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
