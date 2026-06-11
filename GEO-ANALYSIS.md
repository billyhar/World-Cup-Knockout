# GEO Analysis — worldcupknockout.football

*Generated 2026-06-12. Framed per Google's AI Optimization Guide: optimizing for
AI search is still SEO — there is no separate AI index. A page must be indexed
and snippet-eligible in Google Search to appear in any AI feature.*

## GEO Readiness Score: 12 / 100 (deployed) → ~45 / 100 (after pending deploy + prerender)

| Platform | Score | Why |
|---|---|---|
| Google AI Overviews | 10/100 | Not indexed at all yet; no inbound links; JS-only content delays indexing |
| ChatGPT search | 5/100 | GPTBot does not execute JS — sees a 2.5 KB empty shell |
| Perplexity | 5/100 | Same: PerplexityBot reads raw HTML only |
| Bing Copilot | 10/100 | Not in Bing index; no IndexNow |

## The blocking finding: eligibility floor not met

A `"worldcupknockout.football"` web search returns **zero results** — the domain
is not indexed by Google, has no Wikipedia/Reddit/YouTube/LinkedIn mentions, and
no inbound links. Until the site is indexed, no AI surface can cite it. Everything
else in this report is secondary to: **deploy, then submit to Google Search
Console and Bing Webmaster Tools (IndexNow)**.

## AI crawler access

- Deployed `robots.txt`: **404** (default allow-all, but sloppy).
- Pending (committed, undeployed): allow-all + `Disallow: /admin.html` + sitemap. ✅
- No AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, CCBot) are blocked. ✅

## Server-side rendering — critical failure

AI crawlers do **not** execute JavaScript. `curl` of the homepage returns
**2,480 bytes** containing zero content: no team names, no scores, no fixtures.
GPTBot, ClaudeBot, and PerplexityBot see only the `<title>` and meta description.
Google's renderer does execute JS, but JS-only content is indexed on a delayed
second wave — bad for a site whose value is freshness.

**Fix implemented:** `scripts/build-seo.mjs` injects build-time static HTML
(all 12 groups, 48 teams, 104 fixtures with venues) into a `<noscript>` block
plus JSON-LD `SportsEvent` schema, regenerated via `npm run build:seo`.

## llms.txt

Present (pending deploy) and well-formed. Per primary-source evidence (Mueller,
Illyes, SE Ranking 300k-domain study, OtterlyAI logs): **no major AI search
system consumes llms.txt today** — shipped for zero-cost optionality, assigned
no citation weight in this score.

## Citability

Before the prerender fix there were no extractable passages at all. The noscript
block now opens with a self-contained ~60-word definition ("World Cup Knockout is…"),
followed by structured group/fixture data — the format AI engines extract best.

## Brand mentions (3× stronger correlation with AI citations than backlinks)

| Platform | Presence |
|---|---|
| Wikipedia | None |
| Reddit | None |
| YouTube | None |
| LinkedIn | None |

This is a brand-new domain competing against Sofascore, FotMob, ESPN, and
Wikipedia for score queries. Realistic AI-citation goal: not "who won match X"
(Wikipedia/ESPN own that) but the **interactive-canvas niche** — "World Cup 2026
bracket visualizer", "interactive World Cup wall chart". Authentic seeding in
r/worldcup match threads and football Discords is the highest-leverage channel
(Google explicitly rejects inauthentic mention-farming).

## Top 5 highest-impact changes

1. **Deploy the 8 pending commits** — nothing matters until robots/sitemap/meta are live.
2. **Submit to Google Search Console + Bing Webmaster Tools** — request indexing of `/`. Bing feeds ChatGPT and Copilot.
3. **Build-time prerender** (`<noscript>` + SportsEvent JSON-LD) — implemented in this commit.
4. **Share authentically where fans are** — Reddit r/worldcup daily threads, football Discords, a launch post. One genuine viral share during a big match outweighs all on-page work.
5. **Add a visible one-paragraph description** in the page (e.g., in a footer or about modal) — the canvas-only UI gives Google's renderer almost no prose to snippet.
