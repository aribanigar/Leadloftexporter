---
description: Build and publish a CollabMarket recruitment email to the content hub
---

# /publish-collab-email

You are running the CollabMarket content-hub publishing routine.

## Hard rules (do not override)
- **Never hardcode secrets.** All credentials come from environment variables:
  `DATABASE_URL`, `HUB_WORKSPACE`, `PIXABAY_API_KEY`. If any is missing, stop and
  tell the user which to export.
- The content-hub `type` enum is strictly: `html_email | whatsapp | caption | sms | other`.
  Reject anything else.
- **Always inspect the schema and dry-run before writing.** Only insert into the DB
  after the user has seen the schema and explicitly confirms, or passes `--commit`.
- Email copy stays creator-first and benefit-led (Collabstr tone). Tables + inline
  styles only — no flexbox, no external `<style>` reliance.
- Images come from Pixabay and must render in-inbox (embedded base64 OR hosted URLs).

## Steps
1. Confirm env vars are present. If not, print the exact `export` lines needed and stop.
2. Run `python routine.py` (inspect + dry-run). Show the user:
   - the real table + column names found
   - the built email size and whether it risks Gmail clipping (>102KB when `--embed`)
   - the local preview path `collabmarket_email.html`
3. Ask the user to confirm the columns in `publish.py`'s `INSERT_SQL` match the live
   schema. If they differ, edit `INSERT_SQL` to match before any write.
4. On confirmation, run `python routine.py --commit` with the agreed flags
   (`--type`, `--slug`, `--embed`, `--status`). Report the returned row id.

## Safety reminders to surface to the user
- Rotate any DB password that was ever shared in plaintext.
- Only send to a permission-based (opted-in) creator list; wire `{{unsubscribe_url}}`
  to a real link. Cold-blasting hurts deliverability and may breach anti-spam rules.
