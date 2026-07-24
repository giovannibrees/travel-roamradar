# Travel hub - build brief

A personal travel app for one user. The app is the only screen. Everything else is a headless backend behind one Cloudflare Worker.

## Files in this repo
- `travel-app.html` - the front end (the APP). Single file, vanilla JS, persists locally and talks to the worker via `GET /trips` and `POST /trips`. Do not rewrite it; only touch it if the trip/segment data shape below changes. Canonical source; mirrored byte-for-byte to `public/app.html`.
- `website/index.html` - the marketing site (the WEBSITE). Canonical source; mirrored byte-for-byte to `public/index.html`.
- `worker.js` - the Cloudflare Worker hub. Serves BOTH from one domain via `[assets]` = `./public`: `/` -> the website (`public/index.html`), `/app` -> the app (`public/app.html`), and every non-file path (`/trips`, `/sync`, `/t/...`, `/cal.ics`, `/google/*`, cron) -> the worker. ONE deployment, one URL, website + app together.
- `wrangler.toml` - Worker config (cron + KV). Fill in the KV id.

Mirror rule (must always hold before commit): `cp travel-app.html public/app.html` and `cp website/index.html public/index.html`. Two independent mirrors; never cross them.

## Architecture
- Google Calendar (optional): read events overlapping each trip as segments (hotels, rides the user already adds), and write one clean "Trip: X" event per trip.
- Gmail + Anthropic API (optional): parse confirmation emails that only hit the inbox into segments.
- The app is fully usable by hand with none of the above connected; the integrations only make trips fill themselves in.
- App endpoints: `GET /trips` returns consolidated trips with segments; `POST /trips` upserts a trip by id and merges manual plans with ingested ones.

## Data model (keep app and worker in sync)
Trip: `{ id, from, to, start (YYYY-MM-DD), end, label, notes, segments[], calEventId }`
Segment: `{ sid, source ("manual"|"calendar"|"gmail"), type ("flight"|"hotel"|"car"|"ride"|"rail"|"other"), name, address, start, end, conf }`
Rule that must hold: segments tagged `source:"manual"` are user-authored and a sync must NEVER delete or overwrite them. Ingested segments dedupe by `conf`.

## Working on this repo
- Never hardcode any secret. Local dev secrets go in `.dev.vars` (gitignored); production secrets via `wrangler secret put`. Confirm `.gitignore` covers `.dev.vars` and any `.env`.
- Google OAuth: create an OAuth client (Web application). The in-app Connect Google flow mints the refresh token for you with scopes `https://www.googleapis.com/auth/calendar` and `https://www.googleapis.com/auth/gmail.readonly`. Dashboard secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, optional `GOOGLE_CALENDAR_ID`) always win over the in-app copy.
- Deploy: `wrangler kv namespace create TRIPS`, paste the id into `wrangler.toml`, optionally `wrangler secret put` any of (`ANTHROPIC_API_KEY`, the Google trio, optional `CALENDLY_TOKEN`), then `wrangler deploy`. Confirm the cron trigger is active.
- Test end to end: `GET /trips` returns JSON. `POST /trips` with a small trip body creates it. Trigger `POST /sync`, then confirm a calendar event is written and a calendar/Gmail booking inside the trip dates shows up as a segment. Manually add a plan via the app and confirm a later sync does not wipe it.
- Optional ingestion source: if the user wants Calendly instead of Google Calendar, finish the `ingestFromCalendly` stub against the v2 `scheduled_events` API and call it inside `runSync`. Ask before building.

## Migrating existing data
The user can export their trips via the app's Settings (Download) as JSON, then import that JSON back in the app after deploy, or POST each trip to `/trips`, so nothing entered manually is lost.
</content>
