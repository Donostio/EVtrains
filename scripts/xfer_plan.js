/**
 * Build transfer options for SRC->CLJ then CLJ->IMW using RTT search.
 * Writes ./xfer.json (repo root).
 *
 * Fixes:
 * - include services exactly at WINDOW_START (>= not >)
 * - sort by departure time before slicing
 * - optionally include more candidates via MAX_FIRST_LEGS
 */

const fs = require("fs");

const RTT_USER = process.env.RTT_USER;
const RTT_PASS = process.env.RTT_PASS;

if (!RTT_USER || !RTT_PASS) {
  console.error("Missing RTT_USER / RTT_PASS secrets.");
  process.exit(2);
}

const DATE = process.env.DATE || londonISODate(0); // YYYY-MM-DD
const SRC = process.env.SRC || "SRC";
const CLJ = process.env.CLJ || "CLJ";
const IMW = process.env.IMW || "IMW";

const WINDOW_START = process.env.WINDOW_START || "0725"; // inclusive
const WINDOW_END = process.env.WINDOW_END || "0900";     // inclusive-ish (we’ll filter <=)
const MIN_CONNECTION_MINS = parseInt(process.env.MIN_CONNECTION_MINS || "3", 10);

// If you want more rows on the board, bump this (e.g. 6)
const MAX_FIRST_LEGS = parseInt(process.env.MAX_FIRST_LEGS || "6", 10);

function londonISODate(offsetDays) {
  const now = new Date();
  // rough “London date”: fine for your use; avoids pulling in tz libs
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function hhmmToMins(hhmm) {
  if (!hhmm || typeof hhmm !== "string" || hhmm.length < 3) return null;
  const s = hhmm.replace(":", "").padStart(4, "0");
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(2, 4), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minsToHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`;
}

async function rttFetch(url) {
  const auth = Buffer.from(`${RTT_USER}:${RTT_PASS}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${text.slice(0, 400)}`);
  }
  return res.json();
}

// RTT “search” endpoint format you’re using elsewhere:
// https://api.rtt.io/api/v1/json/search/{from}/to/{to}/{yyyy}/{mm}/{dd}/{hhmm}
function searchUrl(from, to, date, hhmm) {
  const [yyyy, mm, dd] = date.split("-");
  const t = (hhmm || "0000").replace(":", "").padStart(4, "0");
  return `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${yyyy}/${mm}/${dd}/${t}`;
}

function pickBestTime(loc, kind /* "dep" | "arr" */) {
  if (!loc) return null;
  // Prefer realtime if present, otherwise booked
  if (kind === "dep") return loc.realtimeDeparture || loc.gbttDeparture || null;
  return loc.realtimeArrival || loc.gbttArrival || null;
}

function delayStatusForLoc(loc) {
  if (!loc) return "unknown";
  if (loc.cancelReasonCode || loc.isCancelled) return "cancelled";
  const d = loc.departureDelayMins;
  const a = loc.arrivalDelayMins;
  const max = Math.max(
    typeof d === "number" ? d : 0,
    typeof a === "number" ? a : 0
  );
  if (max > 0) return "delayed";
  return "on_time";
}

async function main() {
  const wStartM = hhmmToMins(WINDOW_START);
  const wEndM = hhmmToMins(WINDOW_END);

  // 1) Find first-leg services SRC->CLJ from WINDOW_START
  const firstSearch = await rttFetch(searchUrl(SRC, CLJ, DATE, WINDOW_START));
  const firstServices = Array.isArray(firstSearch?.services) ? firstSearch.services : [];

  // Filter within window (inclusive on start), then SORT by booked dep, then slice
  const firstLegCandidates = firstServices
    .map(s => {
      const dep = s?.locationDetail?.gbttBookedDeparture || s?.locationDetail?.gbttDeparture || null;
      const depM = hhmmToMins(dep);
      return { s, dep, depM };
    })
    .filter(x => x.depM !== null && x.depM >= wStartM && x.depM <= wEndM)
    .sort((a, b) => a.depM - b.depM)
    .slice(0, MAX_FIRST_LEGS)
    .map(x => x.s);

  const legs = [];

  for (const s of firstLegCandidates) {
    const uid = s.serviceUid;
    const runDate = s.runDate || DATE;
    if (!uid) continue;

    // 2) Pull service detail to get actual arr/dep at CLJ and platforms
    const svcUrl = `https://api.rtt.io/api/v1/json/service/${uid}/${runDate.replace(/-/g, "/")}`;
    const svc = await rttFetch(svcUrl);

    const locs = Array.isArray(svc?.locations) ? svc.locations : [];
    const srcLoc = locs.find(l => l.crs === SRC)?.locationDetail || null;
    const cljLoc = locs.find(l => l.crs === CLJ)?.locationDetail || null;

    const dep1 = pickBestTime(srcLoc, "dep");
    const arr1 = pickBestTime(cljLoc, "arr");

    const arr1M = hhmmToMins(arr1);
    if (arr1M === null) continue;

    // 3) Find onward CLJ->IMW at/after (arr + MIN_CONNECTION)
    const onwardEarliest = minsToHHMM(arr1M + MIN_CONNECTION_MINS);
    const secondSearch = await rttFetch(searchUrl(CLJ, IMW, DATE, onwardEarliest));
    const secondServices = Array.isArray(secondSearch?.services) ? secondSearch.services : [];

    // Sort onward services too (defensive)
    const onwardSorted = secondServices
      .map(ss => {
        const dep = ss?.locationDetail?.gbttBookedDeparture || ss?.locationDetail?.gbttDeparture || null;
        const depM = hhmmToMins(dep);
        return { ss, depM };
      })
      .filter(x => x.depM !== null)
      .sort((a, b) => a.depM - b.depM)
      .map(x => x.ss);

    let chosen2 = null;

    for (const ss of onwardSorted) {
      const dep2Booked = ss?.locationDetail?.gbttBookedDeparture || ss?.locationDetail?.gbttDeparture || null;
      const dep2BookedM = hhmmToMins(dep2Booked);
      if (dep2BookedM === null) continue;
      if (dep2BookedM < arr1M + MIN_CONNECTION_MINS) continue;
      chosen2 = ss;
      break;
    }

    if (!chosen2) continue;

    // Pull detail for second leg to get realtime times/platforms at CLJ and IMW
    const uid2 = chosen2.serviceUid;
    const runDate2 = chosen2.runDate || DATE;
    const svc2Url = `https://api.rtt.io/api/v1/json/service/${uid2}/${runDate2.replace(/-/g, "/")}`;
    const svc2 = await rttFetch(svc2Url);

    const locs2 = Array.isArray(svc2?.locations) ? svc2.locations : [];
    const cljLoc2 = locs2.find(l => l.crs === CLJ)?.locationDetail || null;
    const imwLoc2 = locs2.find(l => l.crs === IMW)?.locationDetail || null;

    const dep2 = pickBestTime(cljLoc2, "dep");
    const arr2 = pickBestTime(imwLoc2, "arr");

    const status1 = delayStatusForLoc(srcLoc);
    const status2 = delayStatusForLoc(cljLoc2);
    const combinedStatus =
      status1 === "cancelled" || status2 === "cancelled" ? "cancelled"
      : status1 === "delayed" || status2 === "delayed" ? "delayed"
      : "on_time";

    legs.push({
      date: DATE,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
      minConnectionMins: MIN_CONNECTION_MINS,

      first: { from: SRC, to: CLJ, uid, runDate, dep: dep1, arr: arr1, platDep: srcLoc?.platform || null, platArr: cljLoc?.platform || null, status: status1 },
      second: { from: CLJ, to: IMW, uid: uid2, runDate: runDate2, dep: dep2, arr: arr2, platDep: cljLoc2?.platform || null, platArr: imwLoc2?.platform || null, status: status2 },

      cljPlatArr: cljLoc?.platform || null,
      cljPlatDep: cljLoc2?.platform || null,
      status: combinedStatus
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    date: DATE,
    src: SRC,
    clj: CLJ,
    imw: IMW,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    minConnectionMins: MIN_CONNECTION_MINS,
    legs
  };

  fs.writeFileSync("xfer.json", JSON.stringify(out, null, 2));
  console.log(`Wrote xfer.json with ${legs.length} transfer options`);
}

main().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
