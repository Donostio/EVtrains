/**
 * Build transfer options between:
 *   SRC -> CLJ  (leg A)
 *   CLJ -> IMW  (leg B)
 *
 * Outputs xfer.json.
 *
 * Important: RTT "search/.../HHMM" is effectively "from HHMM onwards".
 * So to include earlier trains, we query from (anchor - BACK_MINS),
 * then filter within [anchor-BACK_MINS, anchor+FWD_MINS].
 */

const fs = require("fs");

function env(name, fallback = "") {
  const v = process.env[name];
  return (v === undefined || v === null || v === "") ? fallback : v;
}
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const VERBOSE = env("VERBOSE", "false") === "true";

function log(...args) {
  if (VERBOSE) console.log(...args);
}

function hhmmToMins(hhmm) {
  const s = String(hhmm).padStart(4, "0");
  const h = parseInt(s.slice(0, 2), 10);
  const m = parseInt(s.slice(2, 4), 10);
  return h * 60 + m;
}
function minsToHHMM(mins) {
  mins = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60); // wrap
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, "0") + String(m).padStart(2, "0");
}
function addMinsHHMM(hhmm, delta) {
  return minsToHHMM(hhmmToMins(hhmm) + delta);
}

function basicAuthHeader(user, pass) {
  const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function rttGetJson(url, user, pass) {
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(user, pass),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url} ${text ? `- ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

function pickLoc(t, crs) {
  const locs = t?.locationDetail || t?.locations || [];
  if (!Array.isArray(locs)) return null;
  return locs.find((x) => (x?.crs || x?.station || "").toUpperCase() === crs.toUpperCase()) || null;
}

function getPlatform(loc) {
  return (loc?.platform || loc?.platformConfirmed || loc?.platformNumber || null);
}

function getBookedTime(loc, kind) {
  // kind: "dep" or "arr"
  // RTT fields vary; handle the common ones
  if (!loc) return null;
  if (kind === "dep") return loc.gbttBookedDeparture || loc.bookedDeparture || loc.publicDeparture || null;
  return loc.gbttBookedArrival || loc.bookedArrival || loc.publicArrival || null;
}

function getRealtimeTime(loc, kind) {
  if (!loc) return null;
  if (kind === "dep") return loc.realtimeDeparture || loc.actualDeparture || loc.realtimePublicDeparture || null;
  return loc.realtimeArrival || loc.actualArrival || loc.realtimePublicArrival || null;
}

function delayMins(bookedHHMM, realHHMM) {
  if (!bookedHHMM || !realHHMM) return 0;
  return hhmmToMins(realHHMM) - hhmmToMins(bookedHHMM);
}

function statusFromDelays(depDelay, arrDelay) {
  // RTT also has cancellation flags; we rely on those first where possible.
  const d = Math.max(depDelay ?? 0, arrDelay ?? 0);
  if (d >= 1) return "delayed";
  return "on_time";
}

function inRangeHHMM(hhmm, startMins, endMins) {
  const t = hhmmToMins(hhmm);
  return t >= startMins && t <= endMins;
}

function serviceToLeg(service, fromCRS, toCRS) {
  const fromLoc = pickLoc(service, fromCRS);
  const toLoc = pickLoc(service, toCRS);
  if (!fromLoc || !toLoc) return null;

  const bookedDep = getBookedTime(fromLoc, "dep");
  const bookedArr = getBookedTime(toLoc, "arr");
  const realDep = getRealtimeTime(fromLoc, "dep") || bookedDep;
  const realArr = getRealtimeTime(toLoc, "arr") || bookedArr;

  if (!bookedDep || !bookedArr) return null;

  const depDelay = delayMins(bookedDep, realDep);
  const arrDelay = delayMins(bookedArr, realArr);

  // cancellation flags (varies)
  const cancelled = Boolean(
    fromLoc.isCancelled || toLoc.isCancelled || service.isCancelled || service.cancelled
  );

  const status = cancelled ? "cancelled" : statusFromDelays(depDelay, arrDelay);

  return {
    serviceUid: service.serviceUid || service.uid || service.service || null,
    from: fromCRS,
    to: toCRS,
    dep: bookedDep,
    arr: bookedArr,
    depDelayMins: depDelay,
    arrDelayMins: arrDelay,
    platformFrom: getPlatform(fromLoc) ? String(getPlatform(fromLoc)) : null,
    platformTo: getPlatform(toLoc) ? String(getPlatform(toLoc)) : null,
    status,
  };
}

function buildTransfers(legsA, legsB, minXfer, maxXfer) {
  const transfers = [];
  for (const a of legsA) {
    const arrA = hhmmToMins(a.arr) + (a.arrDelayMins || 0);
    for (const b of legsB) {
      const depB = hhmmToMins(b.dep) + (b.depDelayMins || 0);
      const wait = depB - arrA;
      if (wait >= minXfer && wait <= maxXfer) {
        transfers.push({
          src_clj: a,
          clj_imw: b,
          waitMins: wait,
          change: {
            fromPlatform: a.platformTo,
            toPlatform: b.platformFrom,
          },
        });
      }
    }
  }
  // Sort by earliest arrival at IMW (booked + delay), then shortest wait
  transfers.sort((x, y) => {
    const xArr = hhmmToMins(x.clj_imw.arr) + (x.clj_imw.arrDelayMins || 0);
    const yArr = hhmmToMins(y.clj_imw.arr) + (y.clj_imw.arrDelayMins || 0);
    if (xArr !== yArr) return xArr - yArr;
    return x.waitMins - y.waitMins;
  });
  return transfers;
}

async function main() {
  const user = reqEnv("RTT_USERNAME");
  const pass = reqEnv("RTT_PASSWORD");

  const date = env("WINDOW_DATE");
  if (!date) throw new Error("Missing env WINDOW_DATE");

  const anchorHHMM = env("WINDOW_START_HHMM");
  if (!anchorHHMM) throw new Error("Missing env WINDOW_START_HHMM");

  const backMins = parseInt(env("BACK_MINS", "40"), 10);
  const fwdMins = parseInt(env("FWD_MINS", "180"), 10);
  const minXfer = parseInt(env("MIN_XFER_MINS", "3"), 10);
  const maxXfer = parseInt(env("MAX_XFER_MINS", "20"), 10);

  const SRC = env("SRC_CRS", "SRC");
  const CLJ = env("CLJ_CRS", "CLJ");
  const IMW = env("IMW_CRS", "IMW");

  // Window in minutes
  const anchorMins = hhmmToMins(anchorHHMM);
  const startMins = anchorMins - backMins;
  const endMins = anchorMins + fwdMins;

  // **Critical fix**: query start = anchor - backMins
  const queryStartHHMM = addMinsHHMM(anchorHHMM, -backMins);

  const urlA = `https://api.rtt.io/api/v1/json/search/${SRC}/to/${CLJ}/${date.replaceAll("-", "/")}/${queryStartHHMM}`;
  const urlB = `https://api.rtt.io/api/v1/json/search/${CLJ}/to/${IMW}/${date.replaceAll("-", "/")}/${queryStartHHMM}`;

  log("Window:", { date, anchorHHMM, backMins, fwdMins, queryStartHHMM });
  log("RTT search A:", urlA);
  log("RTT search B:", urlB);

  const jsonA = await rttGetJson(urlA, user, pass);
  const jsonB = await rttGetJson(urlB, user, pass);

  const servicesA = Array.isArray(jsonA?.services) ? jsonA.services : [];
  const servicesB = Array.isArray(jsonB?.services) ? jsonB.services : [];

  const legsA = [];
  for (const s of servicesA) {
    const leg = serviceToLeg(s, SRC, CLJ);
    if (!leg) continue;
    if (inRangeHHMM(leg.dep, startMins, endMins)) legsA.push(leg);
  }

  const legsB = [];
  for (const s of servicesB) {
    const leg = serviceToLeg(s, CLJ, IMW);
    if (!leg) continue;
    if (inRangeHHMM(leg.dep, startMins, endMins)) legsB.push(leg);
  }

  const transfers = buildTransfers(legsA, legsB, minXfer, maxXfer);

  const out = {
    generatedAt: new Date().toISOString(),
    date,
    window: {
      tz: env("TZ", "Europe/London"),
      startHHMM: anchorHHMM,
      backMins,
      fwdMins,
      queryStartHHMM,
    },
    searches: {
      src_clj: urlA,
      clj_imw: urlB,
    },
    legs: {
      src_clj: legsA,
      clj_imw: legsB,
    },
    transfers,
  };

  fs.writeFileSync("xfer.json", JSON.stringify(out, null, 2), "utf8");

  console.log(
    `Wrote xfer.json with ${transfers.length} transfer options (${date} ${anchorHHMM}).`
  );
  if (VERBOSE) {
    console.log(`legsA=${legsA.length} legsB=${legsB.length} window=[${minsToHHMM(startMins)}..${minsToHHMM(endMins)}]`);
  }
}

main().catch((e) => {
  console.error("Error:", e?.message || e);
  process.exit(1);
});
