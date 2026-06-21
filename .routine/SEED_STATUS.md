# Content-hub seed status

## Blocker (action required)

The DB seed (STEP 3) **cannot run from the Claude Code web execution
environment**. The environment's network policy allows only outbound HTTPS
(port 443). The Supabase Postgres pooler listens on **5432 / 6543**, both of
which are blocked:

```
TCP aws-1-ap-northeast-2.pooler.supabase.com:5432  -> timeout (blocked)
TCP aws-1-ap-northeast-2.pooler.supabase.com:6543  -> timeout (blocked)
TCP <host>:443                                      -> open
```

`psycopg2.connect(DATABASE_URL)` therefore fails with `OperationalError:
timeout expired`, and `python publish.py --discover` / `publish.py ... batch.json`
both hang and time out.

The Supabase **REST** API (`https://cmdnezltteldysoxyjzh.supabase.co/rest/v1/`)
is reachable over 443 but returns **401 No API key** — no anon/service_role key
is provided in the environment, so REST is not a usable fallback either.

## What this run produced anyway

Everything except the DB insert is complete and committed:

- `public/email/*` — 6 dark cinematic 4:5 photos, 6 baked promo JPG cards,
  logo, mark, and social icons (all hosted in-repo).
- `batch.json` — 24 content-hub items (6 emails x html_email + whatsapp +
  caption + other), titles tagged `[YYYY-MM-DD]`, types already normalized to
  the content-hub enum, `image_url` pointing at the deployed card URLs.
- `publish.py` — ready to seed, unchanged from spec.

## How to finish the seed

From any environment that can reach the Supabase Postgres port (a laptop, CI
runner, or a web-environment network policy that permits 5432/6543):

```
export DATABASE_URL='postgresql://postgres.cmdnezltteldysoxyjzh:...@aws-1-ap-northeast-2.pooler.supabase.com:5432/postgres'
export HUB_WORKSPACE='1a716353-9472-4c1d-ae89-f95052e8f015'
python publish.py --discover                 # confirm table/column names
python publish.py --folder hudace batch.json # idempotent: re-running skips dup titles
```

Two fixes that would let the scheduled routine seed on its own:
1. Change the web environment's network policy to allow outbound 5432/6543, or
2. Provide a Supabase `service_role` (or anon) API key so a REST-based publish
   path can be added.

## Image hosting note

The card/photo `image_url`s point at `https://leadloftexporter.vercel.app/email/...`.
Those resolve only once `public/email/*` is deployed to the Vercel **production**
domain (i.e. merged to the production branch). Until then the URLs 404.
