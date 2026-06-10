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
- **Backend** — a Netlify Function ([netlify/functions/results.mjs](netlify/functions/results.mjs))
  stores results in Netlify Blobs. Enter scores at `/admin.html` using the
  `ADMIN_TOKEN`.
- **Optional live data** — set `FOOTBALL_DATA_TOKEN` (free key from
  [football-data.org](https://www.football-data.org/), World Cup included in
  the free tier) and [netlify/functions/live.mjs](netlify/functions/live.mjs)
  merges live scores automatically. Manually entered results always win over
  the API, so you can correct anything.
- **Flags** via [flagcdn.com](https://flagcdn.com). Schedule data sourced from
  [openfootball/worldcup](https://github.com/openfootball/worldcup) (CC0).

## Develop

```sh
npm install
echo 'ADMIN_TOKEN=test' > .env
npx netlify dev          # http://localhost:8888
```

Regenerate the fixture data after editing [scripts/build-seed.mjs](scripts/build-seed.mjs):

```sh
npm run build:seed
```

## Deploy

```sh
netlify deploy --prod
netlify env:set ADMIN_TOKEN <your-secret>
```
