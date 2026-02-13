#!/usr/bin/env node
/**
 * xfer_plan.js
 *
 * "Official time only" mode:
 *  - Always display GBTT booked times (public timetable).
 *  - Keep realtime fields in JSON for diagnostics, but NEVER use them for "Used" times.
 *  - Treat "delayed" only when realtime is later than booked (never earlier).
 *  - Cancelled uses isCancelled flags.
 */

const https = require("https");
const fs = require("fs");

const USER = process.env.RTT_USERNAME || "";
const PASS = process.env.RTT_PASSWORD || "";
if (!USER || !PASS) {
  console.error("Missing RTT credentials");
  process.exit(1);
}

const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";
const SRC = "SRC", CLJ = "CLJ", IMW = "IMW";

const WINDOW_START = process.env.WINDOW_START || "0725";
const WINDOW_END   = process.env.WINDOW_END   || "0845";

// Viability + warning thresholds (minutes)
const MIN_TRANSFER_VIABLE = Number.parseInt(process.env.MIN_TRANSFER_VIABLE || "1", 10);
const MIN_TRANSFER_OK     = Number.parseInt(process.env.MIN_TRANSFER_OK || "4", 10);

/* ---------- time helpers (London local) ---------- */
function getLocalParts(date = new Date(), tz = LONDON_TZ) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
}

function localNowHHMM() {
  const p = getLocalParts();
  return `${p.hour}${p.minute}`;
}

function localYMD(offsetDays = 0) {
  const p = getLocalParts();
  // anchor at UTC noon to avoid DST edge weirdness
  const dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  const q = getLocalParts(dt);
  return `${q.year}-${q.month}-${q.day}`; // YYYY-MM-DD
}

function toMin(hhmm) {
  if (!hhmm || hhmm.length !== 4) return null;
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2, 4), 10);
}
function hhmmFromMin(m) {
  const h = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return h + mm;
}
function isoToPath(iso) {
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}
function isoShiftDays(iso, days) {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/* ---------- net ---------- */
function fetchJSON(url) {
  const auth = Buffer.from(`${USER}:${PASS}`).toString("base64");
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
            "User-Agent": "evtrains",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
            }
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

async function search(from, to, datePath, hhmm) {
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url = hhmm ? `${base}/${hhmm}` : base;
  const js = await fetchJSON(url);
  return js?.services || [];
}

const stop = (detail, crs) => (detail?.locations || []).find((l) => l.crs === crs) || {};

async function detailBySvc(svc, iso) {
  if (svc.rid) {
    try {
      return await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`);
    } catch (_e) {}
  }

  const runISO =
    svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate) ? svc.runDate : iso;

  const mk = (u, d) => `https://api.rtt.io/api/v1/json/service/${u}/${d.replace(/-/g, "/")}`;

  try {
    return await fetchJSON(mk(svc.serviceUid, runISO));
  } catch (e) {
    if (!String(e).includes("HTTP 404")) throw e;
    for (const dlt of [+1, -1]) {
      try {
        return await fetchJSON(mk(svc.serviceUid, isoShiftDays(runISO, dlt)));
      } catch (_e) {}
    }
    throw e;
  }
}

/* ---------- status + time selection (official only) ---------- */
function isLater(rt, booked) {
  const a = toMin(rt), b = toMin(booked);
  if (a == null || b == null) return false;
  return a > b;
}

function statusFrom(o, d) {
  if (o?.isCancelled || d?.isCancelled) return "cancelled";

  const depLate = isLater(o?.realtimeDeparture, o?.gbttBookedDeparture);
  const arrLate = isLater(d?.realtimeArrival, d?.gbttBookedArrival);

  return (depLate || arrLate) ? "delayed" : "on_time";
}

// Always return booked as Used; never “estimate”.
function pickDepTimesOfficial(loc) {
  const booked = loc?.gbttBookedDeparture || null;
  const rtVal = loc?.realtimeDeparture || null;

  return {
    booked,
    realtime: rtVal,          // keep for debugging
    used: booked,             // OFFICIAL ONLY
    isEstimated: false,       // never
  };
}
function pickArrTimesOfficial(loc) {
  const booked = loc?.gbttBookedArrival || null;
  const rtVal = loc?.realtimeArrival || null;

  return {
    booked,
    realtime: rtVal,          // keep for debugging
    used: booked,             // OFFICIAL ONLY
    isEstimated: false,       // never
  };
}

/* ---------- main ---------- */
(async () => {
  const nowHHMM = localNowHHMM();
  const todayISO = localYMD(0);
  const tomorrowISO = localYMD(1);

  // After the morning window, switch to tomorrow's window
  const useTomorrow = toMin(nowHHMM) > toMin(WINDOW_END);
  const targetISO = useTomorrow ? tomorrowISO : todayISO;
  const datePath = isoToPath(targetISO);

  console.log(`[xfer_plan] now=${nowHHMM} target=${targetISO} window=${WINDOW_START}-${WINDOW_END} official_only=true`);

  const out = {
    generatedAt: new Date().toISOString(),
    datePath,
    runDate: targetISO,
    dayLabel: useTomorrow ? "Tomorrow" : "Today",
    window: { start: WINDOW_START, end: WINDOW_END },
    thresholds: { viable: MIN_TRANSFER_VIABLE, ok: MIN_TRANSFER_OK },
    direct: null,
    legs: [],
  };

  // --- Direct SRC -> IMW at 07:25 (optional) ---
  try {
    const svcs = await search(SRC, IMW, datePath, WINDOW_START);
    const svc =
      svcs.find((s) => (s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture) === WINDOW_START) ||
      svcs[0];

    if (svc && svc.serviceUid) {
      const det = await detailBySvc(svc, targetISO);
      const o = stop(det, SRC), iw = stop(det, IMW);

      const dep = pickDepTimesOfficial(o);
      const arr = pickArrTimesOfficial(iw);

      out.direct = {
        status: statusFrom(o, iw),

        srcDep: dep.booked,
        srcDepReal: dep.realtime,
        srcDepUsed: dep.used,
        srcDepIsEstimated: dep.isEstimated,
        srcPlat: o.platform || null,

        imwArr: arr.booked,
        imwArrReal: arr.realtime,
        imwArrUsed: arr.used,
        imwArrIsEstimated: arr.isEstimated,
        imwPlat: iw.platform || null,
      };
    }
  } catch (e) {
    console.warn("Direct fetch error:", String(e));
  }

  // --- First legs: SRC -> CLJ strictly AFTER 07:25 and <= 08:45 ---
  try {
    const all = await search(SRC, CLJ, datePath, WINDOW_START);

    const firstLegCandidates = all
      .filter((s) => {
        const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
        const m = toMin(dep);
        return dep && m > toMin(WINDOW_START) && m <= toMin(WINDOW_END);
      })
      .filter((s) => !!s.serviceUid);

    const legs = [];

    for (const svc of firstLegCandidates) {
      if (legs.length >= 3) break;

      let det;
      try {
        det = await detailBySvc(svc, targetISO);
      } catch (e) {
        console.warn("First-leg detail skip:", String(e));
        continue;
      }

      const o = stop(det, SRC);
      const cj = stop(det, CLJ);

      if (!o?.gbttBookedDeparture || !cj?.gbttBookedArrival) continue;

      const dep1 = pickDepTimesOfficial(o);
      const arr1 = pickArrTimesOfficial(cj);

      const arrMin = toMin(arr1.used);
      if (arrMin == null) continue;

      const startHHMM = hhmmFromMin(arrMin + MIN_TRANSFER_VIABLE);

      // Find the earliest CLJ->IMW departure that satisfies transfer >= viable threshold
      let best = null;

      try {
        const cand = await search(CLJ, IMW, datePath, startHHMM);

        for (const c of cand) {
          if (!c?.serviceUid && !c?.rid) continue;

          let cd;
          try {
            cd = await detailBySvc(c, targetISO);
          } catch (_e) {
            continue;
          }

          const cjs = stop(cd, CLJ);
          const imw = stop(cd, IMW);

          if (!cjs?.gbttBookedDeparture || !imw?.gbttBookedArrival) continue;

          const dep2 = pickDepTimesOfficial(cjs);
          const arr2 = pickArrTimesOfficial(imw);

          const depMin = toMin(dep2.used);
          if (depMin == null) continue;
          if (depMin < arrMin + MIN_TRANSFER_VIABLE) continue;

          if (!best || depMin < toMin(best.cljDepUsed)) {
            best = {
              status: statusFrom(cjs, imw),

              cljDep: dep2.booked,
              cljDepReal: dep2.realtime,
              cljDepUsed: dep2.used,
              cljDepIsEstimated: dep2.isEstimated,
              cljPlatDep: cjs.platform || null,

              imwArr: arr2.booked,
              imwArrReal: arr2.realtime,
              imwArrUsed: arr2.used,
              imwArrIsEstimated: arr2.isEstimated,
              imwPlat: imw.platform || null,
            };
          }
        }
      } catch (_e) {}

      const transferMins =
        best && toMin(best.cljDepUsed) != null ? (toMin(best.cljDepUsed) - arrMin) : null;

      const transferViable = transferMins != null && transferMins >= MIN_TRANSFER_VIABLE;
      const transferOk = transferMins != null && transferMins >= MIN_TRANSFER_OK;

      legs.push({
        srcDep: dep1.booked,
        srcDepReal: dep1.realtime,
        srcDepUsed: dep1.used,
        srcDepIsEstimated: dep1.isEstimated,
        srcPlat: o.platform || null,

        cljArr: arr1.booked,
        cljArrReal: arr1.realtime,
        cljArrUsed: arr1.used,
        cljArrIsEstimated: arr1.isEstimated,
        cljPlatArr: cj.platform || null,

        cljDep: best?.cljDep || null,
        cljDepReal: best?.cljDepReal || null,
        cljDepUsed: best?.cljDepUsed || null,
        cljDepIsEstimated: best?.cljDepIsEstimated || false,
        cljPlatDep: best?.cljPlatDep || null,

        imwArr: best?.imwArr || null,
        imwArrReal: best?.imwArrReal || null,
        imwArrUsed: best?.imwArrUsed || null,
        imwArrIsEstimated: best?.imwArrIsEstimated || false,
        imwPlat: best?.imwPlat || null,

        status: best?.status || "not_found",

        transferMins,
        transferViable,
        transferOk,
      });
    }

    out.legs = legs;
  } catch (e) {
    console.warn("First-leg fetch error:", String(e));
  }

  fs.writeFileSync("xfer.json", JSON.stringify(out, null, 2));
  console.log("Wrote xfer.json.");
})();