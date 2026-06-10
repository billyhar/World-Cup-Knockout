// Generates public/data/seed.json from the verified 2026 World Cup schedule
// (source: openfootball/worldcup, CC0). Run: npm run build:seed

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TEAMS = {
  MEX: ["Mexico", "mx"], RSA: ["South Africa", "za"], KOR: ["South Korea", "kr"], CZE: ["Czechia", "cz"],
  CAN: ["Canada", "ca"], BIH: ["Bosnia & Herzegovina", "ba"], QAT: ["Qatar", "qa"], SUI: ["Switzerland", "ch"],
  BRA: ["Brazil", "br"], MAR: ["Morocco", "ma"], HAI: ["Haiti", "ht"], SCO: ["Scotland", "gb-sct"],
  USA: ["United States", "us"], PAR: ["Paraguay", "py"], AUS: ["Australia", "au"], TUR: ["Türkiye", "tr"],
  GER: ["Germany", "de"], CUW: ["Curaçao", "cw"], CIV: ["Ivory Coast", "ci"], ECU: ["Ecuador", "ec"],
  NED: ["Netherlands", "nl"], JPN: ["Japan", "jp"], SWE: ["Sweden", "se"], TUN: ["Tunisia", "tn"],
  BEL: ["Belgium", "be"], EGY: ["Egypt", "eg"], IRN: ["Iran", "ir"], NZL: ["New Zealand", "nz"],
  ESP: ["Spain", "es"], CPV: ["Cape Verde", "cv"], KSA: ["Saudi Arabia", "sa"], URU: ["Uruguay", "uy"],
  FRA: ["France", "fr"], SEN: ["Senegal", "sn"], IRQ: ["Iraq", "iq"], NOR: ["Norway", "no"],
  ARG: ["Argentina", "ar"], ALG: ["Algeria", "dz"], AUT: ["Austria", "at"], JOR: ["Jordan", "jo"],
  POR: ["Portugal", "pt"], COD: ["DR Congo", "cd"], UZB: ["Uzbekistan", "uz"], COL: ["Colombia", "co"],
  ENG: ["England", "gb-eng"], CRO: ["Croatia", "hr"], GHA: ["Ghana", "gh"], PAN: ["Panama", "pa"],
};

const GROUPS = {
  A: ["MEX", "RSA", "KOR", "CZE"], B: ["CAN", "BIH", "QAT", "SUI"],
  C: ["BRA", "MAR", "HAI", "SCO"], D: ["USA", "PAR", "AUS", "TUR"],
  E: ["GER", "CUW", "CIV", "ECU"], F: ["NED", "JPN", "SWE", "TUN"],
  G: ["BEL", "EGY", "IRN", "NZL"], H: ["ESP", "CPV", "KSA", "URU"],
  I: ["FRA", "SEN", "IRQ", "NOR"], J: ["ARG", "ALG", "AUT", "JOR"],
  K: ["POR", "COD", "UZB", "COL"], L: ["ENG", "CRO", "GHA", "PAN"],
};

const VENUES = {
  MexicoCity: ["Estadio Azteca", "Mexico City"],
  Guadalajara: ["Estadio Akron", "Guadalajara"],
  Monterrey: ["Estadio BBVA", "Monterrey"],
  Atlanta: ["Mercedes-Benz Stadium", "Atlanta"],
  Boston: ["Gillette Stadium", "Boston"],
  Dallas: ["AT&T Stadium", "Dallas"],
  Houston: ["NRG Stadium", "Houston"],
  KansasCity: ["Arrowhead Stadium", "Kansas City"],
  LA: ["SoFi Stadium", "Los Angeles"],
  Miami: ["Hard Rock Stadium", "Miami"],
  NYNJ: ["MetLife Stadium", "New York / New Jersey"],
  Philadelphia: ["Lincoln Financial Field", "Philadelphia"],
  SF: ["Levi's Stadium", "SF Bay Area"],
  Seattle: ["Lumen Field", "Seattle"],
  Toronto: ["BMO Field", "Toronto"],
  Vancouver: ["BC Place", "Vancouver"],
};

// [id, date, "HH:MM", utcOffsetHours, home, away, venueKey]
const GROUP_FIXTURES = {
  A: [
    ["A1", "06-11", "13:00", -6, "MEX", "RSA", "MexicoCity"],
    ["A2", "06-11", "20:00", -6, "KOR", "CZE", "Guadalajara"],
    ["A3", "06-18", "12:00", -4, "CZE", "RSA", "Atlanta"],
    ["A4", "06-18", "19:00", -6, "MEX", "KOR", "Guadalajara"],
    ["A5", "06-24", "19:00", -6, "CZE", "MEX", "MexicoCity"],
    ["A6", "06-24", "19:00", -6, "RSA", "KOR", "Monterrey"],
  ],
  B: [
    ["B1", "06-12", "15:00", -4, "CAN", "BIH", "Toronto"],
    ["B2", "06-13", "12:00", -7, "QAT", "SUI", "SF"],
    ["B3", "06-18", "12:00", -7, "SUI", "BIH", "LA"],
    ["B4", "06-18", "15:00", -7, "CAN", "QAT", "Vancouver"],
    ["B5", "06-24", "12:00", -7, "SUI", "CAN", "Vancouver"],
    ["B6", "06-24", "12:00", -7, "BIH", "QAT", "Seattle"],
  ],
  C: [
    ["C1", "06-13", "18:00", -4, "BRA", "MAR", "NYNJ"],
    ["C2", "06-13", "21:00", -4, "HAI", "SCO", "Boston"],
    ["C3", "06-19", "18:00", -4, "SCO", "MAR", "Boston"],
    ["C4", "06-19", "20:30", -4, "BRA", "HAI", "Philadelphia"],
    ["C5", "06-24", "18:00", -4, "SCO", "BRA", "Miami"],
    ["C6", "06-24", "18:00", -4, "MAR", "HAI", "Atlanta"],
  ],
  D: [
    ["D1", "06-12", "18:00", -7, "USA", "PAR", "LA"],
    ["D2", "06-13", "21:00", -7, "AUS", "TUR", "Vancouver"],
    ["D3", "06-19", "12:00", -7, "USA", "AUS", "Seattle"],
    ["D4", "06-19", "20:00", -7, "TUR", "PAR", "SF"],
    ["D5", "06-25", "19:00", -7, "TUR", "USA", "LA"],
    ["D6", "06-25", "19:00", -7, "PAR", "AUS", "SF"],
  ],
  E: [
    ["E1", "06-14", "12:00", -5, "GER", "CUW", "Houston"],
    ["E2", "06-14", "19:00", -4, "CIV", "ECU", "Philadelphia"],
    ["E3", "06-20", "16:00", -4, "GER", "CIV", "Toronto"],
    ["E4", "06-20", "19:00", -5, "ECU", "CUW", "KansasCity"],
    ["E5", "06-25", "16:00", -4, "CUW", "CIV", "Philadelphia"],
    ["E6", "06-25", "16:00", -4, "ECU", "GER", "NYNJ"],
  ],
  F: [
    ["F1", "06-14", "15:00", -5, "NED", "JPN", "Dallas"],
    ["F2", "06-14", "20:00", -6, "SWE", "TUN", "Monterrey"],
    ["F3", "06-20", "12:00", -5, "NED", "SWE", "Houston"],
    ["F4", "06-20", "22:00", -6, "TUN", "JPN", "Monterrey"],
    ["F5", "06-25", "18:00", -5, "JPN", "SWE", "Dallas"],
    ["F6", "06-25", "18:00", -5, "TUN", "NED", "KansasCity"],
  ],
  G: [
    ["G1", "06-15", "12:00", -7, "BEL", "EGY", "Seattle"],
    ["G2", "06-15", "18:00", -7, "IRN", "NZL", "LA"],
    ["G3", "06-21", "12:00", -7, "BEL", "IRN", "LA"],
    ["G4", "06-21", "18:00", -7, "NZL", "EGY", "Vancouver"],
    ["G5", "06-26", "20:00", -7, "EGY", "IRN", "Seattle"],
    ["G6", "06-26", "20:00", -7, "NZL", "BEL", "Vancouver"],
  ],
  H: [
    ["H1", "06-15", "12:00", -4, "ESP", "CPV", "Atlanta"],
    ["H2", "06-15", "18:00", -4, "KSA", "URU", "Miami"],
    ["H3", "06-21", "12:00", -4, "ESP", "KSA", "Atlanta"],
    ["H4", "06-21", "18:00", -4, "URU", "CPV", "Miami"],
    ["H5", "06-26", "19:00", -5, "CPV", "KSA", "Houston"],
    ["H6", "06-26", "18:00", -6, "URU", "ESP", "Guadalajara"],
  ],
  I: [
    ["I1", "06-16", "15:00", -4, "FRA", "SEN", "NYNJ"],
    ["I2", "06-16", "18:00", -4, "IRQ", "NOR", "Boston"],
    ["I3", "06-22", "17:00", -4, "FRA", "IRQ", "Philadelphia"],
    ["I4", "06-22", "20:00", -4, "NOR", "SEN", "NYNJ"],
    ["I5", "06-26", "15:00", -4, "NOR", "FRA", "Boston"],
    ["I6", "06-26", "15:00", -4, "SEN", "IRQ", "Toronto"],
  ],
  J: [
    ["J1", "06-16", "20:00", -5, "ARG", "ALG", "KansasCity"],
    ["J2", "06-16", "21:00", -7, "AUT", "JOR", "SF"],
    ["J3", "06-22", "12:00", -5, "ARG", "AUT", "Dallas"],
    ["J4", "06-22", "20:00", -7, "JOR", "ALG", "SF"],
    ["J5", "06-27", "21:00", -5, "ALG", "AUT", "KansasCity"],
    ["J6", "06-27", "21:00", -5, "JOR", "ARG", "Dallas"],
  ],
  K: [
    ["K1", "06-17", "12:00", -5, "POR", "COD", "Houston"],
    ["K2", "06-17", "20:00", -6, "UZB", "COL", "MexicoCity"],
    ["K3", "06-23", "12:00", -5, "POR", "UZB", "Houston"],
    ["K4", "06-23", "20:00", -6, "COL", "COD", "Guadalajara"],
    ["K5", "06-27", "19:30", -4, "COL", "POR", "Miami"],
    ["K6", "06-27", "19:30", -4, "COD", "UZB", "Atlanta"],
  ],
  L: [
    ["L1", "06-17", "15:00", -5, "ENG", "CRO", "Dallas"],
    ["L2", "06-17", "19:00", -4, "GHA", "PAN", "Toronto"],
    ["L3", "06-23", "16:00", -4, "ENG", "GHA", "Boston"],
    ["L4", "06-23", "19:00", -4, "PAN", "CRO", "Toronto"],
    ["L5", "06-27", "17:00", -4, "PAN", "ENG", "NYNJ"],
    ["L6", "06-27", "17:00", -4, "CRO", "GHA", "Philadelphia"],
  ],
};

// Knockout: slots — "1A" group winner, "2A" runner-up, "3:ABCDF" best third
// from one of those groups, "W74"/"L101" winner/loser of match number.
const KNOCKOUT = [
  // [id, stage, date, "HH:MM", offset, homeSlot, awaySlot, venueKey]
  ["73", "r32", "06-28", "12:00", -7, "2A", "2B", "LA"],
  ["74", "r32", "06-29", "16:30", -4, "1E", "3:ABCDF", "Boston"],
  ["75", "r32", "06-29", "19:00", -6, "1F", "2C", "Monterrey"],
  ["76", "r32", "06-29", "12:00", -5, "1C", "2F", "Houston"],
  ["77", "r32", "06-30", "17:00", -4, "1I", "3:CDFGH", "NYNJ"],
  ["78", "r32", "06-30", "12:00", -5, "2E", "2I", "Dallas"],
  ["79", "r32", "06-30", "19:00", -6, "1A", "3:CEFHI", "MexicoCity"],
  ["80", "r32", "07-01", "12:00", -4, "1L", "3:EHIJK", "Atlanta"],
  ["81", "r32", "07-01", "17:00", -7, "1D", "3:BEFIJ", "SF"],
  ["82", "r32", "07-01", "13:00", -7, "1G", "3:AEHIJ", "Seattle"],
  ["83", "r32", "07-02", "19:00", -4, "2K", "2L", "Toronto"],
  ["84", "r32", "07-02", "12:00", -7, "1H", "2J", "LA"],
  ["85", "r32", "07-02", "20:00", -7, "1B", "3:EFGIJ", "Vancouver"],
  ["86", "r32", "07-03", "18:00", -4, "1J", "2H", "Miami"],
  ["87", "r32", "07-03", "20:30", -5, "1K", "3:DEIJL", "KansasCity"],
  ["88", "r32", "07-03", "13:00", -5, "2D", "2G", "Dallas"],
  ["89", "r16", "07-04", "17:00", -4, "W74", "W77", "Philadelphia"],
  ["90", "r16", "07-04", "12:00", -5, "W73", "W75", "Houston"],
  ["91", "r16", "07-05", "16:00", -4, "W76", "W78", "NYNJ"],
  ["92", "r16", "07-05", "18:00", -6, "W79", "W80", "MexicoCity"],
  ["93", "r16", "07-06", "14:00", -5, "W83", "W84", "Dallas"],
  ["94", "r16", "07-06", "17:00", -7, "W81", "W82", "Seattle"],
  ["95", "r16", "07-07", "12:00", -4, "W86", "W88", "Atlanta"],
  ["96", "r16", "07-07", "13:00", -7, "W85", "W87", "Vancouver"],
  ["97", "qf", "07-09", "16:00", -4, "W89", "W90", "Boston"],
  ["98", "qf", "07-10", "12:00", -7, "W93", "W94", "LA"],
  ["99", "qf", "07-11", "17:00", -4, "W91", "W92", "Miami"],
  ["100", "qf", "07-11", "20:00", -5, "W95", "W96", "KansasCity"],
  ["101", "sf", "07-14", "14:00", -5, "W97", "W98", "Dallas"],
  ["102", "sf", "07-15", "15:00", -4, "W99", "W100", "Atlanta"],
  ["103", "third", "07-18", "17:00", -4, "L101", "L102", "Miami"],
  ["104", "final", "07-19", "15:00", -4, "W101", "W102", "NYNJ"],
];

function toUTC(monthDay, hhmm, offset) {
  const [m, d] = monthDay.split("-").map(Number);
  const [h, min] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, m - 1, d, h - offset, min)).toISOString().replace(".000Z", "Z");
}

const matches = [];
for (const [group, fixtures] of Object.entries(GROUP_FIXTURES)) {
  for (const [id, day, time, off, home, away, venue] of fixtures) {
    matches.push({
      id, stage: "group", group, home, away,
      kickoff: toUTC(day, time, off),
      stadium: VENUES[venue][0], city: VENUES[venue][1],
    });
  }
}
for (const [id, stage, day, time, off, home, away, venue] of KNOCKOUT) {
  matches.push({
    id, stage, home, away,
    kickoff: toUTC(day, time, off),
    stadium: VENUES[venue][0], city: VENUES[venue][1],
  });
}

const teams = Object.fromEntries(
  Object.entries(TEAMS).map(([code, [name, flag]]) => [code, { name, flag }])
);

const seed = { tournament: "FIFA World Cup 2026", teams, groups: GROUPS, matches };
mkdirSync(join(root, "public/data"), { recursive: true });
writeFileSync(join(root, "public/data/seed.json"), JSON.stringify(seed, null, 1));
console.log(`Wrote ${matches.length} matches (${matches.filter(m => m.stage === "group").length} group + ${matches.filter(m => m.stage !== "group").length} knockout)`);
