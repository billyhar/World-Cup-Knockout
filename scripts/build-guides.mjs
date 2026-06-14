// Generates static, server-rendered route guides — one per contender —
// tracing each team's knockout path through the real 2026 bracket in
// seed.json. Static HTML (no JS dependency) so AI crawlers and search
// engines index the full content. Mirrors build-seed/build-seo: pure
// function of the seed, safe to re-run.
//
// Output:
//   public/guides/index.html                     -> /guides/
//   public/guides/<slug>-world-cup-2026-route/    -> one per team
// and rewrites sitemap.xml + the llms.txt Guides section.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUB = join(ROOT, "public");
const ORIGIN = "https://worldcupknockout.football";
const TODAY = "2026-06-13";

const seed = JSON.parse(readFileSync(join(PUB, "data/seed.json"), "utf8"));
const byId = Object.fromEntries(seed.matches.map((m) => [m.id, m]));
const groupOf = (code) =>
  Object.keys(seed.groups).find((g) => seed.groups[g].includes(code));
const teamName = (code) => seed.teams[code]?.name ?? code;

// Teams to generate, in display order. Group is derived from the seed.
const TEAMS = ["ENG", "FRA", "ESP", "POR", "BRA", "ARG", "GER", "NED", "USA", "SCO"];

// Marquee sides named as "potential opponents" deeper in the bracket.
const HEADLINE = new Set([
  "ARG", "BRA", "FRA", "ENG", "ESP", "POR", "GER", "NED", "BEL", "CRO",
  "URU", "USA", "MEX", "MAR", "JPN", "SEN", "COL", "CIV", "SUI", "KOR",
]);

const esc = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// "England's" but "Netherlands'" / "United States'"
const poss = (name) => name.endsWith("s") ? `${name}’` : `${name}’s`;

const slugFor = (name) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}-world-cup-2026-route`;

// team name -> guide slug, for in-content cross-linking between guides
const GUIDE_BY_NAME = Object.fromEntries(
  TEAMS.map((t) => [teamName(t), slugFor(teamName(t))]));
// longest names first so "United States" matches before any substring
const GUIDE_NAMES = Object.keys(GUIDE_BY_NAME).sort((a, b) => b.length - a.length);

// Wrap mentions of *other* guide teams in links. `self` is excluded so an
// article never links to itself. Operates on already-escaped HTML (team names
// carry no HTML-special chars) or on plain markdown.
function crosslink(text, self, md = false) {
  const seen = new Set([self]);
  for (const nm of GUIDE_NAMES) {
    if (seen.has(nm)) continue;
    const re = new RegExp(`\\b${nm}\\b`, "g");
    let first = true;
    text = text.replace(re, (m) => {
      if (!first) return m;       // link only the first mention per section
      first = false;
      seen.add(nm);
      const href = `/guides/${GUIDE_BY_NAME[nm]}/`;
      return md ? `[${m}](${href})` : `<a href="${href}">${m}</a>`;
    });
  }
  return text;
}

// In-page hero photo, if the user dropped one at public/<name>.jpeg
const heroPhoto = (name) => {
  const file = `${name.toLowerCase().replace(/[^a-z]+/g, "")}.jpeg`;
  return existsSync(join(PUB, file)) ? `/${file}` : null;
};

const ROUND = {
  r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", final: "Final",
};

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
});
const timeFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
});
const fmtDate = (iso) => dateFmt.format(new Date(iso));
const fmtTime = (iso) => `${timeFmt.format(new Date(iso))} ET`;
const isoDate = (iso) => iso.slice(0, 10);

// ---- bracket tracing -------------------------------------------------------

// Walk forward from a starting slot (e.g. "1L") through every round to the
// final, recording the match and the opposing slot at each step.
function trace(startSlot) {
  const route = [];
  let cur = seed.matches.find(
    (m) => m.stage === "r32" && (m.home === startSlot || m.away === startSlot));
  let onHome = cur.home === startSlot;
  route.push({ match: cur, opp: onHome ? cur.away : cur.home });
  for (;;) {
    const win = `W${cur.id}`;
    const nxt = seed.matches.find((m) => m.home === win || m.away === win);
    if (!nxt) break;
    onHome = nxt.home === win;
    route.push({ match: nxt, opp: onHome ? nxt.away : nxt.home });
    cur = nxt;
  }
  return route;
}

// All group letters that can transitively feed a slot.
function feedingGroups(slot, acc = new Set()) {
  if (slot.startsWith("W")) {
    const m = byId[slot.slice(1)];
    feedingGroups(m.home, acc);
    feedingGroups(m.away, acc);
  } else if (slot.startsWith("3:")) {
    for (const ch of slot.slice(2)) acc.add(ch);
  } else if (/^[12][A-L]$/.test(slot)) {
    acc.add(slot[1]);
  }
  return acc;
}

// Marquee teams that could occupy a slot, excluding the article's team.
function marquee(slot, self) {
  const out = [];
  for (const g of feedingGroups(slot)) {
    for (const code of seed.groups[g]) {
      if (code !== self && HEADLINE.has(code)) out.push(teamName(code));
    }
  }
  return [...new Set(out)];
}

// Human-readable description of who fills a slot.
function describeSlot(slot) {
  if (/^1[A-L]$/.test(slot)) return `the Group ${slot[1]} winner`;
  if (/^2[A-L]$/.test(slot)) return `the Group ${slot[1]} runner-up`;
  if (slot.startsWith("3:")) {
    const gs = slot.slice(2).split("");
    return `a third-placed team (from Group ${gs.slice(0, -1).join(", Group ")} or Group ${gs.at(-1)})`;
  }
  if (slot.startsWith("W")) {
    const m = byId[slot.slice(1)];
    return `the winner of Match ${m.id} (${describeSlot(m.home)} vs ${describeSlot(m.away)})`;
  }
  return slot;
}

const oxford = (arr) => arr.length <= 1 ? (arr[0] ?? "")
  : `${arr.slice(0, -1).join(", ")} or ${arr.at(-1)}`;

// ---- per-round prose -------------------------------------------------------

function roundProse(team, leg) {
  const { match, opp } = leg;
  const stage = match.stage;
  const where = `${match.stadium}, ${match.city}`;
  const when = `${fmtDate(match.kickoff)}, ${fmtTime(match.kickoff)}`;
  const name = teamName(team);

  if (stage === "r32") {
    return {
      q: `Who could ${name} face in the Round of 32?`,
      body: `In the Round of 32, ${name} would meet ${describeSlot(opp)}. The tie is scheduled for ${when} at ${where} (Match ${match.id}). Win it and ${name} reach the last 16 of the 2026 World Cup.`,
    };
  }
  if (stage === "r16") {
    const m = marquee(opp, team);
    const threat = m.length ? ` Likely contenders from that side include ${oxford(m.slice(0, 4))}.` : "";
    return {
      q: `What is ${poss(name)} Round of 16 path?`,
      body: `A Round-of-16 place would pit ${name} against ${describeSlot(opp)}, played ${when} at ${where} (Match ${match.id}).${threat}`,
    };
  }
  if (stage === "qf") {
    const m = marquee(opp, team);
    const oppId = opp.startsWith("W") ? opp.slice(1) : null;
    const oppPhrase = oppId ? `the winner of Round-of-16 Match ${oppId}` : describeSlot(opp);
    const threat = m.length ? ` Heavyweights lurking in that quarter include ${oxford(m.slice(0, 4))}.` : "";
    return {
      q: `${poss(name)} potential quarter-final`,
      body: `Reaching the quarter-finals would set up Match ${match.id} on ${when} at ${where}, against ${oppPhrase}.${threat}`,
    };
  }
  if (stage === "sf") {
    const m = marquee(opp, team);
    const threat = m.length ? ` Possible opponents from the other half include ${oxford(m.slice(0, 5))}.` : "";
    return {
      q: `Could ${name} reach the semi-finals?`,
      body: `The semi-final (Match ${match.id}) is set for ${when} at ${where}.${threat}`,
    };
  }
  // final
  const m = marquee(opp, team);
  const threat = m.length ? ` Anyone from ${oxford(m.slice(0, 6))} could be waiting on the other side of the draw.` : "";
  return {
    q: `${poss(name)} route to the World Cup 2026 Final`,
    body: `The 2026 World Cup Final is at ${match.stadium}, ${match.city} on ${fmtDate(match.kickoff)} (${fmtTime(match.kickoff)}). It is the last step of ${poss(name)} projected route.${threat}`,
  };
}

// ---- HTML building blocks --------------------------------------------------

function head({ title, desc, url, jsonld, image = `${ORIGIN}/og.png` }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚽️</text></svg>">
<link rel="stylesheet" href="/css/guides.css">
<script defer src="https://cloud.umami.is/script.js" data-website-id="c63b4d7f-d188-4b09-87df-bbcbb0b744a8"></script>
${jsonld.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join("\n")}
</head>
<body>`;
}

const flag = (code) => {
  const f = seed.teams[code]?.flag;
  return f
    ? `<img class="flag" src="https://flagcdn.com/w40/${f}.png" srcset="https://flagcdn.com/w80/${f}.png 2x" alt="" width="26" height="19" loading="lazy" decoding="async">`
    : "";
};

const siteHeader = `
<header class="g-top">
  <a class="brand" href="/">
    <span class="brand-ball">⚽️</span>
    <span class="brand-text"><strong>worldcupknockout.football</strong><span>World Cup 2026</span></span>
  </a>
  <a class="g-cta" href="/">Open the live bracket →</a>
</header>`;

const siteFooter = (links) => `
<footer class="g-foot">
  <p class="g-foot-lead">Follow every result live on the <a href="/">interactive World Cup 2026 bracket</a> — all 104 matches on one pannable canvas, scores updated every 60 seconds.</p>
  <nav class="g-foot-links" aria-label="More route guides">
    <span>More routes:</span>
    ${links}
  </nav>
  <p class="g-foot-fine">worldcupknockout.football · Independent live tracker for the 2026 FIFA World Cup. Routes are projections based on the official bracket; group positions are confirmed once the group stage ends.</p>
</footer>
</body>
</html>`;

// ---- team article ----------------------------------------------------------

function teamArticle(team) {
  const name = teamName(team);
  const grp = groupOf(team);
  const slug = slugFor(name);
  const url = `${ORIGIN}/guides/${slug}/`;
  const ogImage = `${ORIGIN}/og/${slug}.png`;
  const photo = heroPhoto(name);
  const route = trace(`1${grp}`);
  const final = route.at(-1).match;
  const r32 = route[0].match;
  const r16 = route[1].match;

  // group fixtures for this team
  const groupGames = seed.matches
    .filter((m) => m.stage === "group" && m.group === grp && (m.home === team || m.away === team))
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const firstGame = groupGames[0];

  const title = `${poss(name)} Route to the 2026 World Cup Final — Knockout Bracket Path`;
  const desc = `${poss(name)} projected knockout route at the 2026 World Cup: Round of 32, Round of 16, quarter-final, semi-final and final dates, venues and likely opponents if they win Group ${grp}.`;

  const intro = `If ${name} win Group ${grp}, their knockout route runs from a Round of 32 tie in ${r32.city} on ${fmtDate(r32.kickoff)}, through the Round of 16 in ${r16.city} (${fmtDate(r16.kickoff)}), and on toward the Final at ${final.stadium}, ${final.city} on ${fmtDate(final.kickoff)}.`;

  // likely-opponent label for the route table (plain text, reused for markdown)
  const routeOpp = (leg) => {
    const m = leg.match;
    if (m.stage === "r32" || m.stage === "r16") return describeSlot(leg.opp);
    const x = marquee(leg.opp, team);
    return x.length ? `Potentially ${oxford(x.slice(0, 3))}` : describeSlot(leg.opp);
  };

  // route table (opponent cells cross-link to other guides)
  const routeRows = route.map((leg) => {
    const m = leg.match;
    return `<tr>
      <td>${ROUND[m.stage]}</td>
      <td>${fmtDate(m.kickoff)}</td>
      <td>${esc(m.city)}</td>
      <td>${crosslink(esc(routeOpp(leg)), name)}</td>
    </tr>`;
  }).join("\n");

  // per-round prose (mentions of other guide teams become contextual links)
  const roundData = route.map((leg) => roundProse(team, leg));
  const sections = roundData.map(({ q, body }) => `<section class="g-round">
      <h2>${esc(q)}</h2>
      <p>${crosslink(esc(body), name)}</p>
    </section>`).join("\n");

  // group fixtures table
  const fixtureRows = groupGames.map((m) => {
    const opp = m.home === team ? m.away : m.home;
    const ha = m.home === team ? "vs" : "at";
    return `<tr>
      <td>${fmtDate(m.kickoff)}</td>
      <td>${fmtTime(m.kickoff)}</td>
      <td>${flag(team)} ${esc(name)} ${ha} ${flag(opp)} ${esc(teamName(opp))}</td>
      <td>${esc(m.stadium)}, ${esc(m.city)}</td>
    </tr>`;
  }).join("\n");

  // runner-up alternative
  const ruRoute = trace(`2${grp}`);
  const ruR32 = ruRoute[0];
  const ruFinal = ruRoute.at(-1).match;

  const ruRouteOpp = (leg) => {
    const m = leg.match;
    if (m.stage === "r32" || m.stage === "r16") return describeSlot(leg.opp);
    const x = marquee(leg.opp, team);
    return x.length ? `Potentially ${oxford(x.slice(0, 3))}` : describeSlot(leg.opp);
  };

  const ruRouteRows = ruRoute.map((leg) => {
    const m = leg.match;
    return `<tr>
      <td>${ROUND[m.stage]}</td>
      <td>${fmtDate(m.kickoff)}</td>
      <td>${esc(m.city)}</td>
      <td>${crosslink(esc(ruRouteOpp(leg)), name)}</td>
    </tr>`;
  }).join("\n");

  const ruIntro = `As Group ${grp} runner-up, ${name} would enter the other half of the bracket, opening with a Round of 32 tie against ${describeSlot(ruR32.opp)} in ${ruR32.match.city} on ${fmtDate(ruR32.match.kickoff)} (Match ${ruR32.match.id}). The path still converges on the same Final at ${ruFinal.stadium}, ${ruFinal.city} on ${fmtDate(ruFinal.kickoff)}.`;

  // markdown runner-up table
  const mdRuRoute = [
    `| Round | Date | Host city | Likely opponent |`,
    `|---|---|---|---|`,
    ...ruRoute.map((leg) => `| ${ROUND[leg.match.stage]} | ${fmtDate(leg.match.kickoff)} | ${leg.match.city} | ${ruRouteOpp(leg)} |`),
  ].join("\n");

  // FAQ
  const faqs = [
    {
      q: `When do ${name} play their first 2026 World Cup match?`,
      a: `${name} open their Group ${grp} campaign against ${teamName(firstGame.home === team ? firstGame.away : firstGame.home)} on ${fmtDate(firstGame.kickoff)} (${fmtTime(firstGame.kickoff)}) at ${firstGame.stadium}, ${firstGame.city}.`,
    },
    {
      q: `Where would ${name} play the Round of 16?`,
      a: `If ${name} win Group ${grp}, their Round of 16 tie (Match ${r16.id}) is at ${r16.stadium}, ${r16.city} on ${fmtDate(r16.kickoff)}.`,
    },
    {
      q: `What if ${name} finish runner-up in Group ${grp}?`,
      a: `As Group ${grp} runner-up, ${name} would drop into the other half of the bracket. Their Round of 32 tie (Match ${ruR32.match.id}) is against ${describeSlot(ruR32.opp)} in ${ruR32.match.city} on ${fmtDate(ruR32.match.kickoff)}, then the path runs through the Round of 16 in ${ruRoute[1].match.city} and on toward the same Final at ${ruFinal.stadium}, ${ruFinal.city} on ${fmtDate(ruFinal.kickoff)}.`,
    },
    {
      q: `Where is the 2026 World Cup Final?`,
      a: `The 2026 World Cup Final is at ${final.stadium}, ${final.city} on ${fmtDate(final.kickoff)} (${fmtTime(final.kickoff)}).`,
    },
  ];
  const faqHtml = faqs.map((f) => `<details class="g-faq">
    <summary>${esc(f.q)}</summary>
    <p>${esc(f.a)}</p>
  </details>`).join("\n");

  const jsonld = [
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Route Guides", item: `${ORIGIN}/guides/` },
        { "@type": "ListItem", position: 3, name: `${name} route`, item: url },
      ],
    },
    {
      "@context": "https://schema.org", "@type": "Article",
      headline: title,
      description: desc,
      datePublished: TODAY, dateModified: TODAY,
      mainEntityOfPage: url,
      image: `${ORIGIN}/og.png`,
      author: { "@type": "Organization", name: "World Cup Knockout" },
      publisher: {
        "@type": "Organization", name: "World Cup Knockout",
        url: `${ORIGIN}/`,
      },
      about: { "@type": "SportsTeam", name: `${name} national football team` },
    },
    {
      "@context": "https://schema.org", "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ];

  // sibling links (everyone except this team)
  const siblingLinks = TEAMS.filter((t) => t !== team)
    .map((t) => `<a href="/guides/${slugFor(teamName(t))}/">${esc(teamName(t))}</a>`)
    .join("\n    ");

  const heroImg = photo
    ? `<img class="g-hero-photo" src="${photo}" alt="${esc(name)} at the 2026 World Cup" width="1280" height="720" loading="lazy" decoding="async">`
    : "";

  const html = head({ title, desc, url, jsonld, image: ogImage }) + siteHeader + `
<main class="g-article">
  <nav class="g-crumbs" aria-label="Breadcrumb">
    <a href="/">Home</a> › <a href="/guides/">Route guides</a> › <span>${esc(name)}</span>
  </nav>
  <article>
    <header class="g-hero">
      <div class="g-hero-flag">${flag(team)}</div>
      <h1>${esc(poss(name))} Route to the 2026 World Cup Final</h1>
      <p class="g-standfirst">${esc(intro)}</p>
      <p class="g-meta">Group ${grp} · Projected knockout path · Updated ${fmtDate(`${TODAY}T12:00:00Z`)}</p>
    </header>

    ${heroImg}

    <section class="g-table-wrap" aria-label="Projected knockout route">
      <h2>${esc(poss(name))} projected knockout route</h2>
      <table class="g-table">
        <thead><tr><th>Round</th><th>Date</th><th>Host city</th><th>Likely opponent</th></tr></thead>
        <tbody>
${routeRows}
        </tbody>
      </table>
      <p class="g-note">Route assumes ${esc(name)} win Group ${grp}. Opponents are bracket projections until group positions are confirmed.</p>
    </section>

${sections}

    <section class="g-table-wrap" aria-label="Runner-up route">
      <h2>What if ${esc(name)} finish runner-up in Group ${grp}?</h2>
      <p style="color:var(--ink-dim);margin-bottom:16px">${crosslink(esc(ruIntro), name)}</p>
      <table class="g-table">
        <thead><tr><th>Round</th><th>Date</th><th>Host city</th><th>Likely opponent</th></tr></thead>
        <tbody>
${ruRouteRows}
        </tbody>
      </table>
      <p class="g-note">Route assumes ${esc(name)} finish second in Group ${grp}. Opponents are bracket projections until group positions are confirmed.</p>
    </section>

    <section class="g-table-wrap" aria-label="Group stage fixtures">
      <h2>${esc(poss(name))} Group ${grp} fixtures</h2>
      <table class="g-table">
        <thead><tr><th>Date</th><th>Kick-off</th><th>Match</th><th>Venue</th></tr></thead>
        <tbody>
${fixtureRows}
        </tbody>
      </table>
    </section>

    <section class="g-faq-wrap" aria-label="Frequently asked questions">
      <h2>${esc(name)} at the World Cup 2026: FAQ</h2>
${faqHtml}
    </section>
  </article>
</main>` + siteFooter(siblingLinks);

  // ---- markdown twin (served to agents via Accept: text/markdown) ----------
  const mdRoute = [
    `| Round | Date | Host city | Likely opponent |`,
    `|---|---|---|---|`,
    ...route.map((leg) => `| ${ROUND[leg.match.stage]} | ${fmtDate(leg.match.kickoff)} | ${leg.match.city} | ${routeOpp(leg)} |`),
  ].join("\n");
  const mdFixtures = [
    `| Date | Kick-off | Match | Venue |`,
    `|---|---|---|---|`,
    ...groupGames.map((m) => {
      const o = m.home === team ? m.away : m.home;
      const ha = m.home === team ? "vs" : "at";
      return `| ${fmtDate(m.kickoff)} | ${fmtTime(m.kickoff)} | ${name} ${ha} ${teamName(o)} | ${m.stadium}, ${m.city} |`;
    }),
  ].join("\n");
  const md = `# ${poss(name)} Route to the 2026 World Cup Final

> ${intro}

*Group ${grp} · Projected knockout path · Updated ${fmtDate(`${TODAY}T12:00:00Z`)}*

## ${poss(name)} projected knockout route

${mdRoute}

*Route assumes ${name} win Group ${grp}. Opponents are bracket projections until group positions are confirmed.*

${roundData.map(({ q, body }) => `## ${q}\n\n${crosslink(body, name, true)}`).join("\n\n")}

## What if ${name} finish runner-up in Group ${grp}?

${crosslink(ruIntro, name, true)}

${mdRuRoute}

*Route assumes ${name} finish second in Group ${grp}. Opponents are bracket projections until group positions are confirmed.*

## ${poss(name)} Group ${grp} fixtures

${mdFixtures}

## ${name} at the World Cup 2026: FAQ

${faqs.map((f) => `### ${f.q}\n\n${f.a}`).join("\n\n")}

---

Live bracket: ${ORIGIN}/ · All route guides: ${ORIGIN}/guides/
`;

  return { team, slug, html, md, title, desc, name, grp, url, ogImage };
}

// ---- per-team OG image (1200×630, country flag + name) ---------------------

async function buildOG({ team, name, slug }) {
  const code = seed.teams[team]?.flag;
  let flagTag = "";
  if (code) {
    try {
      const res = await fetch(`https://flagcdn.com/w1280/${code}.png`);
      if (res.ok) {
        const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        flagTag = `<image href="data:image/png;base64,${b64}" x="720" y="171" width="410" height="288" preserveAspectRatio="xMidYMid slice" clip-path="url(#fc)"/>`;
      }
    } catch { /* no flag → text-only card */ }
  }
  const FONT = "Helvetica Neue, Arial, sans-serif";
  const nameSize = name.length > 9 ? 76 : 100;
  const svg = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="g1" cx="14%" cy="-12%" r="85%">
      <stop offset="0%" stop-color="#2fe08c" stop-opacity="0.14"/>
      <stop offset="60%" stop-color="#2fe08c" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="g2" cx="98%" cy="112%" r="85%">
      <stop offset="0%" stop-color="#3d6eff" stop-opacity="0.16"/>
      <stop offset="60%" stop-color="#3d6eff" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="fc"><rect x="720" y="171" width="410" height="288" rx="18"/></clipPath>
  </defs>
  <rect width="1200" height="630" fill="#07090f"/>
  <rect width="1200" height="630" fill="url(#g1)"/>
  <rect width="1200" height="630" fill="url(#g2)"/>
  ${flagTag}
  <rect x="720" y="171" width="410" height="288" rx="18" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="2"/>
  <text x="80" y="168" font-family="${FONT}" font-size="26" font-weight="700" letter-spacing="5" fill="#2fe08c">WORLD CUP 2026 · ROUTE GUIDE</text>
  <text x="76" y="312" font-family="${FONT}" font-size="${nameSize}" font-weight="800" fill="#ffffff">${esc(name)}</text>
  <text x="80" y="384" font-family="${FONT}" font-size="46" font-weight="600" fill="#eef1f7">Route to the Final</text>
  <text x="80" y="560" font-family="${FONT}" font-size="26" font-weight="600" fill="#8b93a7">worldcupknockout.football</text>
</svg>`;
  const png = new Resvg(svg, {
    font: { loadSystemFonts: true, defaultFontFamily: "Helvetica Neue" },
  }).render().asPng();
  writeFileSync(join(PUB, "og", `${slug}.png`), png);
}

// ---- hub index -------------------------------------------------------------

function hubPage(articles) {
  const url = `${ORIGIN}/guides/`;
  const title = "World Cup 2026 Route Guides — Every Contender's Knockout Path";
  const desc = "Projected knockout routes for the 2026 World Cup favourites: Round of 32 to the Final, with dates, host cities and likely opponents for England, France, Brazil, Spain, Argentina and more.";

  const cards = articles.map((a) => `<a class="g-card" href="/guides/${a.slug}/">
    <span class="g-card-flag">${flag(TEAMS.find((t) => teamName(t) === a.name))}</span>
    <span class="g-card-text">
      <strong>${esc(poss(a.name))} route to the final</strong>
      <span>Group ${a.grp} · R32 → Final path, dates &amp; opponents</span>
    </span>
  </a>`).join("\n");

  const jsonld = [
    {
      "@context": "https://schema.org", "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Route Guides", item: url },
      ],
    },
    {
      "@context": "https://schema.org", "@type": "CollectionPage",
      name: title, description: desc, url,
      isPartOf: { "@type": "WebSite", name: "World Cup Knockout", url: `${ORIGIN}/` },
    },
    {
      "@context": "https://schema.org", "@type": "ItemList",
      itemListElement: articles.map((a, i) => ({
        "@type": "ListItem", position: i + 1,
        name: `${poss(a.name)} route to the 2026 World Cup final`,
        url: `${ORIGIN}/guides/${a.slug}/`,
      })),
    },
  ];

  const html = head({ title, desc, url, jsonld }) + siteHeader + `
<main class="g-article">
  <nav class="g-crumbs" aria-label="Breadcrumb">
    <a href="/">Home</a> › <span>Route guides</span>
  </nav>
  <header class="g-hero">
    <h1>World Cup 2026 Route Guides</h1>
    <p class="g-standfirst">Projected knockout paths for the leading contenders at the 2026 FIFA World Cup — from the Round of 32 to the Final on 19 July, with dates, host cities and the marquee opponents waiting in each round.</p>
  </header>
  <section class="g-grid">
${cards}
  </section>
</main>` + siteFooter(`<a href="/">Live bracket</a>`);

  const md = `# World Cup 2026 Route Guides

> Projected knockout paths for the leading contenders at the 2026 FIFA World Cup — from the Round of 32 to the Final on 19 July, with dates, host cities and the marquee opponents waiting in each round.

${articles.map((a) => `- [${poss(a.name)} route to the final](${ORIGIN}/guides/${a.slug}/) — Group ${a.grp}`).join("\n")}

---

Live bracket: ${ORIGIN}/
`;
  return { html, md };
}

// Concise markdown summary of the whole tracker, served for the homepage when
// an agent sends Accept: text/markdown.
function homeMarkdown(articles) {
  const groups = Object.entries(seed.groups)
    .map(([g, codes]) => `- **Group ${g}:** ${codes.map(teamName).join(", ")}`)
    .join("\n");
  return `# World Cup 2026 — Live Bracket & Results Tracker

> worldcupknockout.football is a free live tracker for the 2026 FIFA World Cup, hosted by Canada, Mexico and the United States from 11 June to 19 July 2026. It shows all 104 matches — 72 group games across 12 groups and the full knockout bracket from the Round of 32 to the Final — with live scores, standings, goalscorers and cards, updated every minute.

## Groups

${groups}

## Knockout format

Round of 32 → Round of 16 → Quarter-finals → Semi-finals → Final. The Final is at MetLife Stadium, New York / New Jersey on 19 July 2026.

## Route guides

${articles.map((a) => `- [${poss(a.name)} route to the final](${ORIGIN}/guides/${a.slug}/) — Group ${a.grp}`).join("\n")}

## Live data

- Live bracket: ${ORIGIN}/
- Machine-readable summary: ${ORIGIN}/llms.txt
- API catalog: ${ORIGIN}/.well-known/api-catalog
`;
}

// ---- write everything ------------------------------------------------------

const articles = TEAMS.map(teamArticle);

mkdirSync(join(PUB, "guides"), { recursive: true });
mkdirSync(join(PUB, "og"), { recursive: true });
for (const a of articles) {
  const dir = join(PUB, "guides", a.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), a.html);
  writeFileSync(join(dir, "index.md"), a.md);
}
// per-team OG images (flag-based); fetches flags so do it once, in parallel
await Promise.all(articles.map(buildOG));
const hub = hubPage(articles);
writeFileSync(join(PUB, "guides", "index.html"), hub.html);
writeFileSync(join(PUB, "guides", "index.md"), hub.md);
// homepage markdown twin (the canvas HTML can't be meaningfully serialised)
writeFileSync(join(PUB, "index.md"), homeMarkdown(articles));

// sitemap: home + hub + every guide
const urls = [
  { loc: `${ORIGIN}/`, freq: "hourly", pri: "1.0", mod: TODAY },
  { loc: `${ORIGIN}/guides/`, freq: "weekly", pri: "0.8", mod: TODAY },
  ...articles.map((a) => ({ loc: `${ORIGIN}/guides/${a.slug}/`, freq: "weekly", pri: "0.7", mod: TODAY })),
];
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.mod}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join("\n")}
</urlset>
`;
writeFileSync(join(PUB, "sitemap.xml"), sitemap);

// llms.txt: refresh the Guides section
const llmsPath = join(PUB, "llms.txt");
let llms = readFileSync(llmsPath, "utf8").replace(/\n## Route Guides[\s\S]*?(?=\n## |\s*$)/, "");
const guidesBlock = `\n## Route Guides

Projected knockout routes (Round of 32 → Final) for leading contenders, with dates, host cities and likely opponents:

${articles.map((a) => `- [${poss(a.name)} route to the final](${ORIGIN}/guides/${a.slug}/): Group ${a.grp} knockout path`).join("\n")}
- [All route guides](${ORIGIN}/guides/)
`;
// insert before "## Usage" if present, else append
llms = llms.includes("## Usage")
  ? llms.replace(/\n## Usage/, `${guidesBlock}\n## Usage`)
  : llms.trimEnd() + "\n" + guidesBlock;
writeFileSync(llmsPath, llms);

console.log(`Wrote ${articles.length} route guides + hub`);
for (const a of articles) {
  const r = trace(`1${a.grp}`).map((l) => `${ROUND[l.match.stage].replace("Round of ", "R")}→${l.match.city}`).join("  ");
  console.log(`  ${a.name.padEnd(13)} (Grp ${a.grp})  ${r}`);
}
