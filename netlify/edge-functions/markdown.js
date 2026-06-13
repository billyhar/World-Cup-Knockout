// Markdown for Agents: when a client sends `Accept: text/markdown` (and not
// HTML), serve the pre-generated .md twin of the page instead of the HTML.
// Browsers, which send `Accept: text/html`, fall through to the static page.
//
// Wired to "/" and "/guides/*" in netlify.toml. The .md files are built by
// scripts/build-guides.mjs and shipped as static assets.

export default async (request, context) => {
  const accept = request.headers.get("accept") || "";
  // Only intercept explicit markdown requests that don't also want HTML.
  if (!/text\/markdown/i.test(accept) || /text\/html/i.test(accept)) return;

  const url = new URL(request.url);
  let path = url.pathname;
  if (path.endsWith("/")) path += "index.md";
  else if (path.endsWith(".html")) path = `${path.slice(0, -5)}.md`;
  else path += "/index.md";

  // Fetch the static markdown twin. A plain Accept avoids re-triggering us.
  const res = await fetch(new URL(path, url.origin), { headers: { accept: "text/plain" } });
  if (!res.ok) return; // no twin → let the HTML serve

  const body = await res.text();
  return new Response(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
      "vary": "Accept",
      "cache-control": "public, max-age=3600",
    },
  });
};

export const config = { path: ["/", "/guides", "/guides/*"] };
