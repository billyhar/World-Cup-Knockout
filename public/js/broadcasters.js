// Where to watch — location-based, the same way kickoff times localise.
// Kickoffs are stored in UTC and rendered in the viewer's browser timezone;
// here we take that same timezone (the most location-truthful signal the
// browser gives us, with locale region as a fallback) to pick the country,
// then look up which broadcaster carries each match there.
//
// Rights are split per game within a territory (UK: a match is on BBC OR ITV,
// only a few on both), so it's a per-match lookup with the country-wide holder
// as the fallback. Data lives in /data/broadcasters.json so splits can be
// filled in as they're announced without touching code.

// IANA timezone -> country, for the major markets we carry data for. The
// browser's resolved timezone tracks physical location far better than locale,
// so it's the primary signal (matching how kickoff times localise).
const TZ_COUNTRY = {
  // United States
  "America/New_York": "US", "America/Detroit": "US", "America/Chicago": "US",
  "America/Denver": "US", "America/Phoenix": "US", "America/Los_Angeles": "US",
  "America/Anchorage": "US", "America/Boise": "US", "America/Indiana/Indianapolis": "US",
  "America/Kentucky/Louisville": "US", "Pacific/Honolulu": "US",
  // Canada
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA",
  "America/Winnipeg": "CA", "America/Halifax": "CA", "America/St_Johns": "CA",
  "America/Regina": "CA", "America/Montreal": "CA",
  // Mexico
  "America/Mexico_City": "MX", "America/Tijuana": "MX", "America/Monterrey": "MX",
  "America/Cancun": "MX", "America/Merida": "MX", "America/Chihuahua": "MX",
  // Europe
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR",
  "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT",
  "Europe/Lisbon": "PT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE",
  "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Warsaw": "PL",
  "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  // South America
  "America/Sao_Paulo": "BR", "America/Bahia": "BR", "America/Fortaleza": "BR",
  "America/Recife": "BR", "America/Manaus": "BR",
  "America/Argentina/Buenos_Aires": "AR", "America/Argentina/Cordoba": "AR",
  "America/Argentina/Mendoza": "AR",
  // Asia-Pacific
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU",
  "Australia/Perth": "AU", "Australia/Adelaide": "AU",
  "Asia/Tokyo": "JP", "Asia/Seoul": "KR",
  "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  // MENA / Gulf
  "Asia/Dubai": "AE", "Asia/Qatar": "QA", "Asia/Riyadh": "SA",
  "Africa/Cairo": "EG", "Africa/Casablanca": "MA",
  // Africa
  "Africa/Johannesburg": "ZA",
};

let data = null;       // loaded broadcasters.json
let country = null;    // detected country code we actually have data for
let info = null;       // { name, on } for the viewer's country

function detectCountry(countries) {
  // Primary: physical-location timezone, the same signal that localises kickoffs.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const c = TZ_COUNTRY[tz];
    if (c && countries[c]) return c;
  } catch { /* ignore */ }
  // Fallback: locale region (en-GB -> GB, en -> US after maximize()).
  try {
    for (const lang of navigator.languages ?? [navigator.language]) {
      if (!lang) continue;
      const region = new Intl.Locale(lang).maximize().region;
      if (region && countries[region]) return region;
    }
  } catch { /* ignore */ }
  return null;
}

export async function loadBroadcasters() {
  try {
    data = await fetch("/data/broadcasters.json").then((r) => (r.ok ? r.json() : null));
  } catch { data = null; }
  if (data?.countries) {
    country = detectCountry(data.countries);
    info = country ? data.countries[country] : null;
  }
  return info;
}

// Channel(s) carrying a given match in the viewer's country: the per-match
// override if we have one, else the country-wide holder, else null (no line).
export function watchOn(matchId) {
  if (!info) return null;
  const on = data.matches?.[matchId]?.[country] ?? info.on;
  return on ? { on, name: info.name } : null;
}
