#!/usr/bin/env node
// Migrate Netlify Blobs (store "worldcup") to the Supabase `kv` table.
//
// Usage:
//   NETLIFY_SITE_ID=<site-id> NETLIFY_TOKEN=<pat> SUPABASE_SERVICE_ROLE_KEY=<key> \
//     node scripts/migrate-blobs-to-supabase.mjs [--dry-run]
//
// Get your Netlify site ID from the site's General settings page.
// Get a personal access token from Netlify → User settings → Applications → Personal access tokens.

import { getStore } from "@netlify/blobs";

const SUPABASE_URL = "https://xozkbbbejhcsglopnoqn.supabase.co";
const REST = `${SUPABASE_URL}/rest/v1/kv`;

const KEYS = ["results", "live-output", "live-api", "odds-api"];

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const siteID = env("NETLIFY_SITE_ID");
  const token = env("NETLIFY_TOKEN");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");

  const store = getStore({ name: "worldcup", siteID, token });

  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  console.log(`Migrating blobs from Netlify site ${siteID} to Supabase...`);
  if (dryRun) console.log("DRY RUN — no writes to Supabase");

  for (const key of KEYS) {
    let value;
    try {
      value = await store.get(key, { type: "json" });
    } catch (err) {
      console.log(`  ${key}: not found or unreadable (${err.message})`);
      continue;
    }

    if (value == null) {
      console.log(`  ${key}: empty/null — skipped`);
      continue;
    }

    console.log(`  ${key}: found (${JSON.stringify(value).length} bytes)`);

    if (dryRun) continue;

    const res = await fetch(REST, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });

    if (!res.ok) {
      console.error(`  ${key}: FAILED to write — ${res.status} ${await res.text()}`);
    } else {
      console.log(`  ${key}: written to Supabase`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
