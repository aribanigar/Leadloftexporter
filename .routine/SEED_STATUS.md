# Content-hub seed status

## Resolved: seed runs over HTTPS via the Supabase REST API

The scheduled web environment allows **only outbound HTTPS (443)**. The
Supabase Postgres pooler ports (**5432 / 6543**) are firewalled, so the
psycopg2 path in `publish.py` cannot connect (`OperationalError: timeout
expired`).

The working path is **`publish_rest.py`**, which talks to the Supabase REST
(PostgREST) API on 443. The 2026-06-21 batch (24 items) was seeded this way:

```
created=24 skipped=0 failed=0   (re-run: skipped=24 -> idempotent)
```

### Required env for the REST path

```
SUPABASE_URL=https://cmdnezltteldysoxyjzh.supabase.co
SUPABASE_SECRET_KEY=<sb_secret_... secret key>   # privileged, bypasses RLS
HUB_WORKSPACE=1a716353-9472-4c1d-ae89-f95052e8f015
```

Add `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to the routine environment so
future scheduled runs can seed themselves. (The Postgres `DATABASE_URL` alone
is not usable here because of the port firewall.)

Run:

```
python publish_rest.py --folder hudace batch.json
```

## Real hub schema (discovered via the REST OpenAPI spec)

The schema differs from `publish.py`'s defaults, so `publish_rest.py` maps to
the real columns:

- **`content_assets`** is the content-item table:
  `id, workspace_id, business_id, title, type, content` (body), `subject,
  platform, tags` (jsonb, **NOT NULL**), `image_url, created_at, updated_at`.
- **`content_businesses`** is the "folder" table (one row per brand).
  The `hudace` folder already exists: `id =
  7ab57d94-9f43-40e4-b6a0-1ca6575ce24c`, slug `hudace`, in workspace
  `Ace Media` (`1a716353-...`).
- There is **no** `folder_id`/`status` column; the folder link is
  `business_id`, and `tags` must be a non-null JSON array.

`type` values used: `html_email | whatsapp | caption | other` (matches the
content-hub enum). `publish.py` (psycopg2) is kept for environments that *can*
reach Postgres directly.

## Image hosting note

Card/photo `image_url`s point at `https://leadloftexporter.vercel.app/email/...`.
Those resolve only once `public/email/*` is deployed to the Vercel
**production** branch. The images are currently committed to
`claude/exciting-archimedes-zmesxn`; merge to the production branch (or push the
batch to it) so the URLs serve.

## Security note

The Supabase secret key was provided interactively and used only in-process to
seed; it is **not** stored in any committed file. Rotate it in the Supabase
dashboard (Project Settings -> API -> Secret keys) since it was pasted into a
chat transcript.
