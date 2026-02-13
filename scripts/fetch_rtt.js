#!/usr/bin/env node
/**
 * fetch_rtt.js
 *
 * Minimal + robust:
 * - Pull service via RTT search
 * - Pull full service detail
 * - Use RTT fields:
 *    gbttBookedDeparture/Arrival (booked)
 *    realtimeDeparture/Arrival   (updated)
 *    isCancelled
 * - Status:
 *    cancelled if either end cancelled
 *    delayed if realtime > booked by >= 1 min (dep or arr)
 *    on_time otherwise
 */

const https = require("https");
const fs = require("fs");

const USER = process.env.RTT_USERNAME || "";
const PASS = process.env.RTT_PASSWORD || "";
if (!USER || !PASS) {
  console.error("Missing RTT credentials (RTT_USERNAME/RTT_PASSWORD).");
  process.exit(1);
}

const ORIGIN = process.env.ORIGIN_CRS || "STE";
const DEST = process.env.DEST_CRS || "WIM";
const DEP_TIME = (process.env.DEP_TIME || "0744").replace(":", ""); // HHMM

const TZ = "Europe/London";

function authHeader() {
  return "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            Authorization: authHeader(),
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

function londonParts(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
}

function londonISO(offsetDays = 0) {
  const p = londonParts();
  const dt = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  const q = londonParts(dt);
  return `${q.year}-${q.month}-${q.day}`;
}

function isoToPath(iso) {
  const [y, m, d] = iso.split("-");
  return `${y}/${m}/${d}`;
}

function toMin(hhmm) {
  if (!hhmm || hhmm.length !== 4) return null;
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = parseInt(hhmm.slice(2, 4), 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minsDiff(a, b) {
  const am = toMin(a), bm = toMin(b);
  if (am == null || bm == null) return null;
  return am - bm;
}

function isLaterByAtLeast1(rt, booked) {
  const d = minsDiff(rt, booked);
  return d != null && d >= 1;
}

async function searchServices(from, to, datePath, hhmm) {
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url = hhmm ? `${base}/${hhmm}` : base;
  const js = await fetchJSON(url);
  return js?.services || [];
}

function pickService(services, targetHHMM) {
  if (!services.length) return null;

  // RTT tends to place booked times at:
  // service.locationDetail.gbttBookedDeparture (search response)
  const exact = services.find((s) => (s?.locationDetail?.gbttBookedDeparture || "") === targetHHMM);
  if (exact) return exact;

  // Otherwise choose nearest by booked dep
  let best = services[0];
  let bestDist = Infinity;

  for (const s of services) {
    const dep = s?.locationDetail?.gbttBookedDeparture;
    const d = minsDiff(dep, targetHHMM);
    if (d == null) continue;
    const dist = Math.abs(d);
    if (dist < bestDist) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

async function fetchServiceDetail(svc, runISO) {
  // Prefer rid if present (most direct)
  if (svc?.rid) {
    return fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`);
  }

  // Fall back to uid/date style
  const uid = svc?.serviceUid;
  if (!uid) throw new Error("Service has no rid or serviceUid.");

  const url = `https://api.rtt.io/api/v1/json/service/${uid}/${runISO.replace(/-/g, "/")}`;
  return fetchJSON(url);
}

function stop(detail, crs) {
  return (detail?.locations || []).find((l) => l.crs === crs) || {};
}

function deriveStatus(o, d) {
  if (o?.isCancelled || d?.isCancelled) return "cancelled";

  const depLate = isLaterByAtLeast1(o?.realtimeDeparture, o?.gbttBookedDeparture);
  const arrLate = isLaterByAtLeast1(d?.realtimeArrival, d?.gbttBookedArrival);

  return (depLate || arrLate) ? "delayed" : "on_time";
}

(async () => {
  // Decide today vs tomorrow based on whether target dep time has likely passed.
  // Keeps it simple: if now (London) is after 22:30, look at tomorrow.
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  const nowHHMM = `${now.hour}${now.minute}`;

  const baseISO = londonISO(0);
  const useTomorrow = toMin(nowHHMM) != null && toMin(nowHHMM) > toMin("2230");
  const runISO = useTomorrow ? londonISO(1) : baseISO;
  const datePath = isoToPath(runISO);

  console.log(`[fetch_rtt] ${ORIGIN}->${DEST} dep=${DEP_TIME} runDate=${runISO}`);

  const services = await searchServices(ORIGIN, DEST, datePath, DEP_TIME);
  const svc = pickService(services, DEP_TIME);

  if (!svc) {
    const out = {
      generatedAt: new Date().toISOString(),
      date: runISO,
      originCRS: ORIGIN,
      destinationCRS: DEST,
      gbttBookedDeparture: DEP_TIME,
      status: "no_service",
      origin: { bookedDeparture: DEP_TIME },
      destination: {},
    };
    fs.writeFileSync("status.json", JSON.stringify(out, null, 2));
    console.log("[fetch_rtt] No services found. Wrote status.json with status=no_service.");
    process.exit(0);
  }

  const detail = await fetchServiceDetail(svc, runISO);
  const o = stop(detail, ORIGIN);
  const d = stop(detail, DEST);

  const originBookedDep = o?.gbttBookedDeparture || null;
  const originRTDep = o?.realtimeDeparture || null;

  const destBookedArr = d?.gbttBookedArrival || null;
  const destRTArr = d?.realtimeArrival || null;

  const out = {
    generatedAt: new Date().toISOString(),
    date: runISO,
    serviceUid: svc.serviceUid || null,
    rid: svc.rid || null,
    runDate: runISO,
    originCRS: ORIGIN,
    destinationCRS: DEST,
    gbttBookedDeparture: originBookedDep || DEP_TIME,
    origin: {
      bookedDeparture: originBookedDep,
      realtimeDeparture: originRTDep,
      departureDelayMins: minsDiff(originRTDep, originBookedDep),
      platform: o?.platform || null,
      isCancelled: !!o?.isCancelled,
      cancelReasonCode: o?.cancelReasonCode || null,
      cancelReasonShortText: o?.cancelReasonShortText || null,
    },
    destination: {
      bookedArrival: destBookedArr,
      realtimeArrival: destRTArr,
      arrivalDelayMins: minsDiff(destRTArr, destBookedArr),
      platform: d?.platform || null,
      isCancelled: !!d?.isCancelled,
      cancelReasonCode: d?.cancelReasonCode || null,
      cancelReasonShortText: d?.cancelReasonShortText || null,
    },
  };

  out.status = deriveStatus(o, d);

  // Useful for debugging without drowning in RTT payload
  out.debug = {
    pickedBookedDeparture: svc?.locationDetail?.gbttBookedDeparture || null,
    pickedServiceUid: svc?.serviceUid || null,
  };

  fs.writeFileSync("status.json", JSON.stringify(out, null, 2));
  console.log(`[fetch_rtt] Wrote status.json status=${out.status} dep=${originBookedDep}/${originRTDep}`);
})();
