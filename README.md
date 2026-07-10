# World Cup 2026 — Knockout Canvas

Every group, result and knockout match of the 2026 FIFA World Cup on one
pannable, zoomable canvas. All 104 matches, 12 groups, country flags, and a
bracket that resolves itself as results come in.

## How it works

- **Canvas** ([public/index.html](public/index.html)) — drag to pan, pinch or
  `⌘`/`ctrl` + scroll to zoom, double-click to zoom in. Nav chips fly to each
  stage. Fully responsive; touch gestures on mobile, plus a rotate button on
  phones that turns the canvas 90° for landscape reading.
- **Local times** — every kickoff is shown in the visitor's timezone with the
  abbreviation in the corner pill (e.g. BST); today's matches are highlighted.
- **Bracket auto-resolution** — group standings are computed from results
  (points → goal difference → goals for → head-to-head). When all groups are
  final, the eight best third-placed teams are allocated to their R32 slots by
  constraint matching, and every `Winner M74`-style slot fills itself from
  knockout results (including penalty shootouts).
- **Backend** — Vercel serverless functions in [`api/`](api/):
  - [`api/results.mjs`](api/results.mjs) stores confirmed results + bracket overrides.
  - [`api/live.mjs`](api/live.mjs) serves the live-score feed.
  - [`api/predictions.mjs`](api/predictions.mjs) handles match-winner predictions.
  - [`api/odds.mjs`](api/odds.mjs) serves outright winner odds.
- **Storage** — a Supabase `kv` table replaces Netlify Blobs. State keys:
  `live-output`, `live-api`, `results`, `odds-api`.
- **Live polling** — a Cloudflare Worker cron triggers once a minute and pings
  `/api/poll-live` with a bearer secret. The poller fetches from
  football-data.org + ESPN and writes the computed feed to Supabase.
- **Admin** — enter scores at `/admin.html` using the `ADMIN_TOKEN`.
- **Optional live data** — set `FOOTBALL_DATA_TOKEN` (free key from
  [football-data.org](https://www.football-data.org/), World Cup included in
  the free tier). Manually entered results always win over the API, so you can
  correct anything.
- **Flags** via [flagcdn.com](https://flagcdn.com). Schedule data sourced from
  [openfootball/worldcup](https://github.com/openfootball/worldcup) (CC0).

## Develop

```sh
npm install
npm run build
npm run dev                 # http://localhost:3000 (Vercel)
```

Regenerate the fixture data after editing [scripts/build-seed.mjs](scripts/build-seed.mjs):

```sh
npm run build:seed
```

## Deploy

### 1. Supabase schema

Apply the migrations in [`supabase/migrations/`](supabase/migrations/) to create
the `kv` table, the predictions tables/RPC, and the RLS policies:

```sh
supabase migration up
```

(Or run the SQL files directly in the Supabase SQL editor.)

### 2. Migrate data from Netlify Blobs (one-time, if moving an existing site)

The old Netlify Functions stored state in Netlify Blobs under the `worldcup`
store. To copy that data into the new Supabase `kv` table:

```sh
NETLIFY_SITE_ID=<site-id> \
NETLIFY_TOKEN=<personal-access-token> \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run migrate:blobs
```

Add `--dry-run` to preview what would be copied without writing anything.
The `netlify/` directory and `netlify.toml` have been removed from this repo;
this script is the only remaining Netlify dependency and is kept only for the
one-time migration.

### 3. Vercel environment variables

| Variable | Required for | Where to get it |
|---|---|---|
| `ADMIN_TOKEN` | `/admin.html` score entry | Any strong secret you generate |
| `FOOTBALL_DATA_TOKEN` | Live scores | [football-data.org](https://www.football-data.org/) dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | KV reads/writes (`api/_lib/kv.mjs`) | Supabase project settings → API |
| `SUPABASE_ANON_KEY` | Predictions | Supabase project settings → API |
| `CRON_SECRET` | Secures `/api/poll-live` | Any strong secret you generate |
| `ODDS_API_KEY` | Bookmaker odds | [the-odds-api.com](https://the-odds-api.com/) (optional) |

```sh
vercel env add ADMIN_TOKEN
vercel env add FOOTBALL_DATA_TOKEN
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add SUPABASE_ANON_KEY
vercel env add CRON_SECRET
vercel env add ODDS_API_KEY    # optional
vercel deploy
```

### 4. Cloudflare Worker cron

The live-score poller runs as a Cloudflare Worker cron because Vercel's free
plan can't run minute-level crons.

```sh
# Set the same CRON_SECRET you used in Vercel
wrangler secret put CRON_SECRET

# Optional: point cron at a preview URL during testing
wrangler secret put POLL_URL   # e.g. https://your-branch.vercel.app/api/poll-live

npm run cursors:deploy
```

The worker also hosts the live-cursor / emoji-reaction relay used by
[`public/js/presence.js`](public/js/presence.js).

## Netlify → Vercel migration notes

- `netlify.toml` and the `netlify/` directory have been removed.
- `netlify/edge-functions/markdown.js` is ported to `middleware.js`.
- `netlify/functions/*` are ported to `api/*.mjs`.
- Netlify Blobs are replaced by the Supabase `kv` table.
- The live-score scheduled function is replaced by the Cloudflare Worker cron.
- Supabase RLS policies lock down the `kv` and predictions tables so anonymous
  clients can only read public vote tallies; all writes go through Vercel
  functions or the `cast_vote` RPC.
