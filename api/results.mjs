import { kvGet, kvSet } from "./_lib/kv.mjs";

const json = (body, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": cache },
  });

export const GET = async () => {
  const data = await kvGet("results");
  // Cache at the CDN for 60s so all users share one invocation per minute.
  // POST writes bypass caching (no-store), and the 60s TTL is acceptable
  // since the live endpoint is also on a 60s refresh cycle.
  return json(data ?? { results: {}, overrides: {} }, 200, "public, s-maxage=60, max-age=0");
};

export const POST = async (req) => {
  const token = req.headers.get("x-admin-token");
  if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
    return json({ error: "Unauthorized" }, 401);
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const data = {
    results: body.results ?? {},
    overrides: body.overrides ?? {},
    updatedAt: new Date().toISOString(),
  };
  await kvSet("results", data);
  return json({ ok: true, updatedAt: data.updatedAt });
};
