// Injects crawler-readable content into public/index.html from seed.json:
//  - a <noscript> block with every group, team and fixture (AI crawlers like
//    GPTBot/PerplexityBot/ClaudeBot don't execute JS, so without this they see
//    an empty shell)
//  - JSON-LD: WebSite + SportsEventSeries + a compact SportsEvent per match
// Content sits between seo:start / seo:end markers so reruns are idempotent.
// Run: npm run build:seo (after any build:seed change)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(join(root, "public/data/seed.json"), "utf8"));
const htmlPath = join(root, "public/index.html");

const SITE = "https://worldcupknockout.football";
const teamName = (code) => seed.teams[code]?.name ?? code;
const fmtDay = (iso) => new Date(iso).toISOString().slice(0, 10);

// ---- noscript content -------------------------------------------------------

const STAGE_LABEL = {
  r32: "Round of 32", r16: "Round of 16", qf: "Quarter-final",
  sf: "Semi-final", third: "Third place play-off", final: "Final",
};

const slotText = (slot) => {
  if (/^1[A-L]$/.test(slot)) return `Winner Group ${slot[1]}`;
  if (/^2[A-L]$/.test(slot)) return `Runner-up Group ${slot[1]}`;
  if (slot.startsWith("3:")) return `Third-placed team (${slot.slice(2).split("").join("/")})`;
  if (slot.startsWith("W")) return `Winner Match ${slot.slice(1)}`;
  if (slot.startsWith("L")) return `Loser Match ${slot.slice(1)}`;
  return slot;
};

let ns = `
<noscript>
<main>
<h1>World Cup 2026 — every group, result and knockout match</h1>
<p>World Cup Knockout is a free live tracker for the 2026 FIFA World Cup,
hosted by Canada, Mexico and the United States from 11 June to 19 July 2026.
It shows all 104 matches — 72 group games across 12 groups and the full
knockout bracket from the Round of 32 to the Final — with live scores,
group standings, goalscorers and cards, updated every minute.</p>
`;

for (const [g, teams] of Object.entries(seed.groups)) {
  ns += `<h2>Group ${g}</h2>\n<p>Teams: ${teams.map(teamName).join(", ")}.</p>\n<ul>\n`;
  for (const m of seed.matches.filter((m) => m.stage === "group" && m.group === g)) {
    ns += `<li>${fmtDay(m.kickoff)}: ${teamName(m.home)} v ${teamName(m.away)} — ${m.stadium}, ${m.city}</li>\n`;
  }
  ns += `</ul>\n`;
}

ns += `<h2>Knockout stage</h2>\n<ul>\n`;
for (const m of seed.matches.filter((m) => m.stage !== "group")) {
  const home = seed.teams[m.home] ? teamName(m.home) : slotText(m.home);
  const away = seed.teams[m.away] ? teamName(m.away) : slotText(m.away);
  ns += `<li>${STAGE_LABEL[m.stage]} (M${m.id}, ${fmtDay(m.kickoff)}): ${home} v ${away} — ${m.stadium}, ${m.city}</li>\n`;
}
ns += `</ul>\n`;

// ---- head-term FAQ (answer blocks for "when is the world cup 2026" etc.) ----

const faqs = [
  {
    q: "When is the 2026 FIFA World Cup?",
    a: "The 2026 FIFA World Cup runs from 11 June to 19 July 2026, co-hosted by Canada, Mexico and the United States.",
  },
  {
    q: "Where is the 2026 World Cup final?",
    a: "The 2026 World Cup final is at MetLife Stadium in New York / New Jersey on Sunday 19 July 2026.",
  },
  {
    q: "How many teams are in the 2026 World Cup?",
    a: "48 teams play in the 2026 World Cup — the first 48-team edition — drawn into 12 groups of four. The top two from each group plus the eight best third-placed teams advance to a 32-team knockout bracket.",
  },
  {
    q: "How does the 2026 World Cup knockout bracket work?",
    a: "After the group stage, 32 teams enter a straight knockout: Round of 32, Round of 16, quarter-finals, semi-finals and the final, plus a third-place play-off. Lose once and you are out.",
  },
  {
    q: "Which teams could win the 2026 World Cup?",
    a: "Pre-tournament favourites include Argentina, France, Brazil, England, Spain, Portugal, Germany and the Netherlands. See each side's projected knockout route at worldcupknockout.football/guides.",
  },
];

ns += `<h2>World Cup 2026 FAQ</h2>\n`;
for (const f of faqs) ns += `<h3>${f.q}</h3>\n<p>${f.a}</p>\n`;
ns += `<p>Projected knockout routes for the favourites: <a href="/guides/">World Cup 2026 route guides</a>.</p>\n`;
ns += `</main>\n</noscript>`;

// ---- JSON-LD ----------------------------------------------------------------

const events = seed.matches.map((m) => {
  const home = seed.teams[m.home] ? teamName(m.home) : slotText(m.home);
  const away = seed.teams[m.away] ? teamName(m.away) : slotText(m.away);
  const label = m.stage === "group" ? `Group ${m.group}` : STAGE_LABEL[m.stage];
  return {
    "@type": "SportsEvent",
    name: `${home} v ${away} — World Cup 2026 ${label}`,
    startDate: m.kickoff,
    location: { "@type": "Place", name: m.stadium, address: m.city },
  };
});

const ld = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      name: "World Cup Knockout",
      url: `${SITE}/`,
      description: "Live tracker for the 2026 FIFA World Cup: all 104 matches, 12 groups and the full knockout bracket on one pannable canvas.",
    },
    {
      "@type": "SportsEventSeries",
      name: "2026 FIFA World Cup",
      startDate: "2026-06-11",
      endDate: "2026-07-19",
      location: [
        { "@type": "Country", name: "Canada" },
        { "@type": "Country", name: "Mexico" },
        { "@type": "Country", name: "United States" },
      ],
      subEvent: events,
    },
    {
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

const block = `<!-- seo:start (generated by scripts/build-seo.mjs — do not edit by hand) -->
<script type="application/ld+json">${JSON.stringify(ld)}</script>
${ns}
<!-- seo:end -->`;

// ---- inject -----------------------------------------------------------------

let html = readFileSync(htmlPath, "utf8");
const marker = /<!-- seo:start[\s\S]*?<!-- seo:end -->/;
if (marker.test(html)) {
  html = html.replace(marker, block);
} else {
  html = html.replace("</body>", `${block}\n</body>`);
}
writeFileSync(htmlPath, html);
console.log(`Injected SEO block: ${(block.length / 1024).toFixed(1)} KB (${events.length} SportsEvents)`);
