import { getStore } from "@netlify/blobs";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async function handler(req) {
  const store = getStore("worldcup");

  if (req.method === "GET") {
    const data = await store.get("results", { type: "json" });
    return json(data ?? { results: {}, overrides: {} });
  }

  if (req.method === "POST") {
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
    await store.setJSON("results", data);
    return json({ ok: true, updatedAt: data.updatedAt });
  }

  return json({ error: "Method not allowed" }, 405);
}
