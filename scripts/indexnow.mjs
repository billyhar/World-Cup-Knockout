// Pings IndexNow (Bing, Yandex, and others — feeds Microsoft Copilot) with
// every URL in public/sitemap.xml so new/changed pages get crawled in minutes
// instead of waiting for an organic recrawl. Run after a deploy:
//   node scripts/indexnow.mjs
// The key file public/<KEY>.txt must already be live at the site root.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "worldcupknockout.football";
const KEY = "48a0062e3dba43cbb9f3d0de4de83352";

const sitemap = readFileSync(join(ROOT, "public/sitemap.xml"), "utf8");
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList,
  }),
});

console.log(`IndexNow: ${res.status} ${res.statusText} for ${urlList.length} URLs`);
if (!res.ok) console.log(await res.text());
