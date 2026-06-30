// Cache-busts the static JS/CSS that index.html loads. Those assets are served
// with a 1-hour CDN/browser cache (+ stale-while-revalidate), so without a
// version on the URL a deploy is invisible to returning visitors for up to an
// hour — they keep running old code against fresh data. index.html itself is
// served must-revalidate (max-age=0), so stamping a content hash onto the asset
// URLs there means a changed file is picked up immediately, while an unchanged
// file keeps the same URL and stays cached.
//
// Idempotent: re-running replaces any existing ?v=. Runs on every Netlify
// deploy (see netlify.toml [build] command) so it can never be forgotten.

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../public/", import.meta.url);
const hash = (rel) =>
  createHash("sha256").update(readFileSync(new URL(rel, root))).digest("hex").slice(0, 10);

const jsHash = hash("js/app.js");
const cssHash = hash("css/styles.css");

const indexUrl = new URL("index.html", root);
let html = readFileSync(indexUrl, "utf8");
html = html
  .replace(/(\/js\/app\.js)(\?v=[^"']*)?/g, `$1?v=${jsHash}`)
  .replace(/(\/css\/styles\.css)(\?v=[^"']*)?/g, `$1?v=${cssHash}`);
writeFileSync(indexUrl, html);

console.log(`cachebust: app.js?v=${jsHash}  styles.css?v=${cssHash}`);
