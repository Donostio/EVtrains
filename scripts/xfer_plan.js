// scripts/xfer_plan.js
// Builds simple transfer options for SRC->CLJ + CLJ->IMW around a time window.
// Writes xfer.json for the dashboard (index.html expects {direct, transfers, generatedAt,...})

const fs = require("fs");

const USER = process.env.RTT_USERNAME;
const PASS = process.env.RTT_PASSWORD;

if (!USER || !PASS) {
  console.error("Missing RTT_USERNAME / RTT_PASSWORD secrets.");
  process.exit(2);
}

const TZ = process.env.TZ || "Europe/London";

// Window behaviour:
// - WINDOW_START_HHMM: anchor time for searches (HHMM). If omitted, uses "now" (London time).
// - BACK_MINS / FWD_MINS: how far back/forward from anchor to consider trains (used by pairing logic).
// Note: RTT search endpoint takes a single HHMM; it returns a board around that time.
const WINDOW_START_HHMM = process.env.WINDOW_START_HHMM || ""; // e.g. "0735"
const BACK_MINS = parseInt(process.env.BACK_MINS || "40", 10);
const FWD_MINS = parseInt(process.env.FWD_MINS || "180", 10);

// Stations
const SRC = process.env.SRC_CRS || "SRC";
const CLJ = process.env.CLJ_CRS || "CLJ";
const IMW = process.env.IMW_CRS || "IMW";

// For “tomorrow morning” boards during the day:
// - If WINDOW_DATE is provided, use it (YYYY-MM-DD).
// - Else use today in Europe/London.
const WINDOW_DATE = process.env.WINDOW_DATE || ""; // YYYY-MM-DD

// Transfer constraints
const MIN_XFER_MINS = parseInt(process.env.MIN_XFER_MINS || "3", 10);
const MAX_XFER_MINS = parseInt(process.env.MAX_XFER_MINS || "20", 10);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function londonNowParts() {
  // Use Intl to get Europe/London “now” without extra deps.
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const HH = get("hour");
  const MM = get("minute");
  return { yyyy, mm, dd, HH, MM };
}

function ymdTodayLondon() {
  const { yyyy, mm, dd } = londonNowParts();
  return `${yyyy}-${mm}-${dd}`;
}

function hhmmNowLondon() {
  const { HH, MM } = londonNowParts();
  return `${HH}${MM}`;
}

function toYMD(dateStr) {
  // Expects YYYY-MM-DD; minimal sanity.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return "";
  return dateStr;
}

function hhmmToMins(hhmm) {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(2, 4), 10);
  return h * 60 + m;
}

function minsToHHMM(totalMins) {
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return `${pad2(h)}${pad2(m)}`;
}

async function rttGet(url) {
  const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

function pickLoc(call, crs) {
  if (!call || !Array.isArray(call.locations)) return null;
  return call.locations.find((l) => (l.crs || "").toUpperCase() === crs.toUpperCase()) || null;
}

function locTimes(loc) {
  // RTT provides a mixture depending on endpoint. We prefer:
  // - realtimeDeparture/realtimeArrival if present
  // - otherwise gbttBookedDeparture/gbttBookedArrival
  const dep =
    (loc.realtimeDeparture || loc.realtimeGBTTDeparture || loc.gbttBookedDeparture || "").replace(":", "");
  const arr =
    (loc.realtimeArrival || loc.realtimeGBTTArrival || loc.gbttBookedArrival || "").replace(":", "");
  const depDelay =
    typeof loc.departureDelay === "number"
      ? loc.departureDelay
      : typeof loc.departureDelayMins === "number"
      ? loc.departureDelayMins
      : 0;
  const arrDelay =
    typeof loc.arrivalDelay === "number"
      ? loc.arrivalDelay
      : typeof loc.arrivalDelayMins === "number"
      ? loc.arrivalDelayMins
      : 0;

  return { dep, arr, depDelayMins: depDelay, arrDelayMins: arrDelay };
}

function statusFromDelays(depDelay, arrDelay, cancelled) {
  if (cancelled) return "cancelled";
  if ((depDelay || 0) > 0 || (arrDelay || 0) > 0) return "delayed";
  return "on_time";
}

function normPlatform(p) {
  if (p === null || p === undefined) return "";
  return String(p).trim();
}

function inWindow(hhmm, anchorHHMM, backMins, fwdMins) {
  if (!hhmm || hhmm.length !== 4) return false;
  const t = hhmmToMins(hhmm);
  const a = hhmmToMins(anchorHHMM);
  return t >= a - backMins && t <= a + fwdMins;
}

async function main() {
  const date = toYMD(WINDOW_DATE) || ymdTodayLondon();
  const startHHMM = WINDOW_START_HHMM || hhmmNowLondon();

  // RTT Search API:
  // https://api.rtt.io/api/v1/json/search/{from}/to/{to}/{yyyy}/{mm}/{dd}/{hhmm}
  const [yyyy, mm, dd] = date.split("-");
  const srcCljUrl = `https://api.rtt.io/api/v1/json/search/${SRC}/to/${CLJ}/${yyyy}/${mm}/${dd}/${startHHMM}`;
  const cljImwUrl = `https://api.rtt.io/api/v1/json/search/${CLJ}/to/${IMW}/${yyyy}/${mm}/${dd}/${startHHMM}`;

  const out = {
    generatedAt: new Date().toISOString(),
    date,
    window: { tz: TZ, startHHMM, backMins: BACK_MINS, fwdMins: FWD_MINS },
    searches: { src_clj: srcCljUrl, clj_imw: cljImwUrl },
    // index.html expects these:
    direct: null,
    transfers: [],
    // optional debug:
    legs: { src_clj: [], clj_imw: [] },
  };

  const [srcClj, cljImw] = await Promise.all([rttGet(srcCljUrl), rttGet(cljImwUrl)]);

  const srcServices = (srcClj.services || []).slice(0, 50);
  const cljServices = (cljImw.services || []).slice(0, 50);

  // Normalise legs SRC->CLJ
  for (const s of srcServices) {
    const from = pickLoc(s, SRC);
    const to = pickLoc(s, CLJ);
    if (!from || !to) continue;

    const ft = locTimes(from);
    const tt = locTimes(to);
    const cancelled = !!(from.isCancelled || to.isCancelled || s.isCancelled);

    const dep = ft.dep;
    const arr = tt.arr;

    if (!inWindow(dep, startHHMM, BACK_MINS, FWD_MINS) && !inWindow(arr, startHHMM, BACK_MINS, FWD_MINS)) {
      continue;
    }

    out.legs.src_clj.push({
      serviceUid: s.serviceUid || s.uid || "",
      from: SRC,
      to: CLJ,
      dep,
      arr,
      depDelayMins: ft.depDelayMins || 0,
      arrDelayMins: tt.arrDelayMins || 0,
      platformFrom: normPlatform(from.platform),
      platformTo: normPlatform(to.platform),
      status: statusFromDelays(ft.depDelayMins, tt.arrDelayMins, cancelled),
    });
  }

  // Normalise legs CLJ->IMW
  for (const s of cljServices) {
    const from = pickLoc(s, CLJ);
    const to = pickLoc(s, IMW);
    if (!from || !to) continue;

    const ft = locTimes(from);
    const tt = locTimes(to);
    const cancelled = !!(from.isCancelled || to.isCancelled || s.isCancelled);

    const dep = ft.dep;
    const arr = tt.arr;

    if (!inWindow(dep, startHHMM, BACK_MINS, FWD_MINS) && !inWindow(arr, startHHMM, BACK_MINS, FWD_MINS)) {
      continue;
    }

    out.legs.clj_imw.push({
      serviceUid: s.serviceUid || s.uid || "",
      from: CLJ,
      to: IMW,
      dep,
      arr,
      depDelayMins: ft.depDelayMins || 0,
      arrDelayMins: tt.arrDelayMins || 0,
      platformFrom: normPlatform(from.platform),
      platformTo: normPlatform(to.platform),
      status: statusFromDelays(ft.depDelayMins, tt.arrDelayMins, cancelled),
    });
  }

  // Pair transfers: SRC->CLJ arrival then CLJ->IMW departure within MIN/MAX transfer mins
  const transfers = [];
  for (const a of out.legs.src_clj) {
    if (!a.arr) continue;
    const aArrMins = hhmmToMins(a.arr);

    for (const b of out.legs.clj_imw) {
      if (!b.dep) continue;
      const bDepMins = hhmmToMins(b.dep);

      const wait = bDepMins - aArrMins;
      if (wait < MIN_XFER_MINS || wait > MAX_XFER_MINS) continue;

      // Shape expected by index.html
      transfers.push({
        srcDep: a.dep,
        srcPlat: a.platformFrom || "",
        cljArr: a.arr,
        cljPlatArr: a.platformTo || "",
        transferMins: wait,
        cljDep: b.dep,
        cljDepUsed: b.dep, // “used” = realtime already baked into dep
        cljPlatDep: b.platformFrom || "",
        imwArr: b.arr,
        imwArrUsed: b.arr, // realtime already baked into arr
        imwPlat: b.platformTo || "",
        status: a.status === "delayed" || b.status === "delayed" ? "delayed" : "on_time",
      });
    }
  }

  // Keep a sensible number, sorted by earliest SRC departure then shortest transfer
  transfers.sort((x, y) => {
    const xd = hhmmToMins(x.srcDep);
    const yd = hhmmToMins(y.srcDep);
    if (xd !== yd) return xd - yd;
    return x.transferMins - y.transferMins;
  });

  out.transfers = transfers.slice(0, 12);

  fs.writeFileSync("xfer.json", JSON.stringify(out, null, 2));
  console.log(`Wrote xfer.json with ${out.transfers.length} transfer options (${out.date} ${out.window.startHHMM}).`);
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
