// RFC 9727 API catalog at /.well-known/api-catalog (via a rewrite in
// netlify.toml). Served from a function so the content-type is reliably
// application/linkset+json — Netlify's static server forces octet-stream on
// the extensionless well-known path. Advertises the site's public read-only
// JSON feeds.

const ORIGIN = "https://worldcupknockout.football";

const linkset = {
  linkset: [
    {
      anchor: `${ORIGIN}/api/live`,
      "service-doc": [
        { href: `${ORIGIN}/llms.txt`, type: "text/plain", title: "Live scores feed — in-play and finished results, scorers and cards (JSON)" },
      ],
      status: [{ href: `${ORIGIN}/api/live` }],
    },
    {
      anchor: `${ORIGIN}/api/results`,
      "service-doc": [
        { href: `${ORIGIN}/llms.txt`, type: "text/plain", title: "Confirmed results and bracket overrides feed (JSON)" },
      ],
      status: [{ href: `${ORIGIN}/api/results` }],
    },
    {
      anchor: `${ORIGIN}/api/odds`,
      "service-doc": [
        { href: `${ORIGIN}/llms.txt`, type: "text/plain", title: "Outright winner odds — live bookmaker market (de-vigged) with bracket-model fallback (JSON)" },
      ],
      status: [{ href: `${ORIGIN}/api/odds` }],
    },
  ],
};

export default async () =>
  new Response(JSON.stringify(linkset, null, 2), {
    headers: {
      "content-type": "application/linkset+json",
      "cache-control": "public, max-age=86400",
    },
  });
