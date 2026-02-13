/**
 * Fetch a single tracked service (e.g. STE->WIM 07:44) from Realtime Trains
 * and write status.json + append to history.jsonl.
 *
 * Env:
 *  - RTT_USER / RTT_PASS (preferred) OR RTT_USERNAME / RTT_PASSWORD
 *  - ORIGIN_CRS, DEST_CRS, BOOKED_DEPART_HHMM (e.g. "0744")
 *  - LONDON_TZ (default "Europe/London")
 *  - SWITCH_GRACE_MINS (default "2")
 */

const fs = require("fs");
const path = require("path");

const OUT_STATUS = path.join(process.cwd(), "status.json");
const OUT_HISTORY = path.join(process.cwd(), "history.jsonl");

function envCreds() {
  const user = process.env.RTT_USER || process.env.RTT_USERNAME;
  const pass = process.env.RTT_PASS || process.env.RTT_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "Missing RTT credentials. Provide secrets as RTT_USER/RTT_PASS (preferred) or RTT_USERNAME/RTT_PASSWORD."
    );
  }
  return { user, pass };
}

function mustEnv(name, fallback = null) {
  const v = process.env[name] ?? fallback;
  if (v == null || v === "") throw new Error(`Missing env ${name}`);
  return v;
}

function londonNowParts(tz = "Europe/London") {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // en-GB gives DD/MM/YYYY, HH:MM
  const parts = fmt.formatToParts(d).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    yyyy: parts.year,
    mm: parts.month,
    dd: parts.day,
    hh: parts.hour,
    mi: parts.minute,
  };
}

function hmToMins(hm) {
  const h = Number(hm.slice(0, 2));
  const m = Number(hm.slice(2, 4));
  return h * 60 + m;
}

function minsToHM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}${m}`;
}

async function rttFetchJson(url, user, pass) {
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${txt.slice(0, 500)}`);
  }
  return res.json();
}

function pickCall(loc) {
  // RTT locationDetail commonly has these for realtime:
  // - realtimeArrival / realtimeDeparture (HHMM) (often the *working* public estimate)
  // - actualArrival / actualDeparture (HHMM) (when known)
  // If actual is present, use it; else use realtime; else booked.
  const bookedArr = loc.gbttBookedArrival || null;
  const bookedDep = loc.gbttBookedDeparture || null;

  const rtArr = loc.realtimeArrival || null;
  const rtDep = loc.realtimeDeparture || null;

  const actArr = loc.actualArrival || null;
  const actDep = loc.actualDeparture || null;

  const effectiveArr = actArr || rtArr || bookedArr;
  const effectiveDep = actDep || rtDep || bookedDep;

  const isEstimated =
    // “Estimated” if we’re using realtime (not actual) and it differs from booked
    (!actDep && !!rtDep && rtDep !== bookedDep) ||
    (!actArr && !!rtArr && rtArr !== bookedArr);

  return {
    bookedArrival: bookedArr,
    bookedDeparture: bookedDep,
    realtimeArrival: rtArr,
    realtimeDeparture: rtDep,
    actualArrival: actArr,
    actualDeparture: actDep,
    effectiveArrival: effectiveArr,
    effectiveDeparture: effectiveDep,
    isEstimated,
  };
}

function delayMins(bookedHHMM, effectiveHHMM) {
  if (!bookedHHMM || !effectiveHHMM) return null;
  return hmToMins(effectiveHHMM) - hmToMins(bookedHHMM);
}

async function main() {
  const { user, pass } = envCreds();

  const ORIGIN_CRS = mustEnv("ORIGIN_CRS");
  const DEST_CRS = mustEnv("DEST_CRS");
  const BOOKED_DEPART_HHMM = mustEnv("BOOKED_DEPART_HHMM"); // "0744"
  const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";
  const SWITCH_GRACE_MINS = Number(process.env.SWITCH_GRACE_MINS || "2");

  // Decide which *date* to query.
  // We query “today” until (effective departure + grace) has passed, then switch to tomorrow.
  const now = londonNowParts(LONDON_TZ);
  const today = { yyyy: now.yyyy, mm: now.mm, dd: now.dd };

  // First try today.
  const searchUrlToday = `https://api.rtt.io/api/v1/json/search/${ORIGIN_CRS}/to/${DEST_CRS}/${today.yyyy}/${today.mm}/${today.dd}/${BOOKED_DEPART_HHMM}`;

  let chosenDate = `${today.yyyy}-${today.mm}-${today.dd}`;
  let searchJson;

  try {
    searchJson = await rttFetchJson(searchUrlToday, user, pass);
  } catch (e) {
    // If search fails (e.g. RTT hiccup), log and hard-fail so Actions shows it.
    appendHistory({ error: String(e), when: new Date().toISOString() });
    throw e;
  }

  const services = Array.isArray(searchJson.services) ? searchJson.services : [];
  const match = services.find((s) => s?.serviceUid); // RTT usually returns the exact train in that slice

  if (!match) {
    const msg = `No service found in search slice: ${searchUrlToday}`;
    appendHistory({ error: msg, when: new Date().toISOString() });
    throw new Error(msg);
  }

  // Pull full service detail
  const serviceUid = match.serviceUid;
  const detailUrlToday = `https://api.rtt.io/api/v1/json/service/${serviceUid}/${today.yyyy}/${today.mm}/${today.dd}`;

  let detailJson = await rttFetchJson(detailUrlToday, user, pass);

  // Find origin + destination locationDetail rows
  const locs = Array.isArray(detailJson.locations) ? detailJson.locations : [];
  const originLoc = locs.find((l) => l?.crs === ORIGIN_CRS);
  const destLoc = locs.find((l) => l?.crs === DEST_CRS);

  if (!originLoc || !destLoc) {
    const msg = `Could not find origin/destination CRS in service detail (uid=${serviceUid}).`;
    appendHistory({ error: msg, when: new Date().toISOString(), detailUrl: detailUrlToday });
    throw new Error(msg);
  }

  const originCall = pickCall(originLoc);
  const destCall = pickCall(destLoc);

  // Switch-to-tomorrow logic:
  // If we’re past (effective departure OR booked departure) + grace, then use tomorrow’s service instead.
  const effectiveDep = originCall.effectiveDeparture || originCall.bookedDeparture || BOOKED_DEPART_HHMM;
  const nowMins = Number(now.hh) * 60 + Number(now.mi);
  const depMins = hmToMins(effectiveDep);
  const pastDep = nowMins > depMins + SWITCH_GRACE_MINS;

  if (pastDep) {
    // Query tomorrow
    const d = new Date();
    // add 1 day in real time, then format in London tz
    d.setUTCDate(d.getUTCDate() + 1);
    const tmr = londonNowParts(LONDON_TZ); // recompute from “now”; good enough for your use-case
    // safer: build tomorrow by incrementing today
    const tomorrowDate = new Date(`${today.yyyy}-${today.mm}-${today.dd}T12:00:00Z`);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const y = tomorrowDate.getUTCFullYear();
    const m = String(tomorrowDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(tomorrowDate.getUTCDate()).padStart(2, "0");

    const searchUrlTomorrow = `https://api.rtt.io/api/v1/json/search/${ORIGIN_CRS}/to/${DEST_CRS}/${y}/${m}/${day}/${BOOKED_DEPART_HHMM}`;
    const searchJsonTomorrow = await rttFetchJson(searchUrlTomorrow, user, pass);
    const servicesTomorrow = Array.isArray(searchJsonTomorrow.services) ? searchJsonTomorrow.services : [];
    const matchTomorrow = servicesTomorrow.find((s) => s?.serviceUid);

    if (matchTomorrow?.serviceUid) {
      chosenDate = `${y}-${m}-${day}`;
      const detailUrlTomorrow = `https://api.rtt.io/api/v1/json/service/${matchTomorrow.serviceUid}/${y}/${m}/${day}`;
      detailJson = await rttFetchJson(detailUrlTomorrow, user, pass);

      const locs2 = Array.isArray(detailJson.locations) ? detailJson.locations : [];
      const origin2 = locs2.find((l) => l?.crs === ORIGIN_CRS);
      const dest2 = locs2.find((l) => l?.crs === DEST_CRS);

      if (origin2 && dest2) {
        // overwrite with tomorrow
        Object.assign(originCall, pickCall(origin2));
        Object.assign(destCall, pickCall(dest2));
      }
    }
  }

  const originDelay = delayMins(originCall.bookedDeparture, originCall.effectiveDeparture);
  const destDelay = delayMins(destCall.bookedArrival, destCall.effectiveArrival);

  const isCancelled =
    Boolean(originLoc.isCancelled) ||
    Boolean(destLoc.isCancelled) ||
    Boolean(detailJson.isCancelled);

  const cancelReasonCode = originLoc.cancelReasonCode || destLoc.cancelReasonCode || null;
  const cancelReasonShortText = originLoc.cancelReasonShortText || destLoc.cancelReasonShortText || null;

  // Status: prefer cancellation, else delayed if departure delay > 0, else on_time.
  let status = "on_time";
  if (isCancelled) status = "cancelled";
  else if ((originDelay ?? 0) > 0 || (destDelay ?? 0) > 0) status = "delayed";

  const payload = {
    generatedAt: new Date().toISOString(),
    date: chosenDate,
    serviceUid,
    runDate: chosenDate,
    originCRS: ORIGIN_CRS,
    destinationCRS: DEST_CRS,
    gbttBookedDeparture: BOOKED_DEPART_HHMM,
    origin: {
      bookedArrival: originCall.bookedArrival,
      bookedDeparture: originCall.bookedDeparture,
      realtimeArrival: originCall.realtimeArrival,
      realtimeDeparture: originCall.realtimeDeparture,
      actualArrival: originCall.actualArrival,
      actualDeparture: originCall.actualDeparture,
      effectiveArrival: originCall.effectiveArrival,
      effectiveDeparture: originCall.effectiveDeparture,
      departureDelayMins: originDelay,
      arrivalDelayMins: delayMins(originCall.bookedArrival, originCall.effectiveArrival),
      platform: originLoc.platform || null,
      isCancelled,
      cancelReasonCode,
      cancelReasonShortText,
      isEstimated: originCall.isEstimated,
    },
    destination: {
      bookedArrival: destCall.bookedArrival,
      bookedDeparture: destCall.bookedDeparture,
      realtimeArrival: destCall.realtimeArrival,
      realtimeDeparture: destCall.realtimeDeparture,
      actualArrival: destCall.actualArrival,
      actualDeparture: destCall.actualDeparture,
      effectiveArrival: destCall.effectiveArrival,
      effectiveDeparture: destCall.effectiveDeparture,
      arrivalDelayMins: destDelay,
      departureDelayMins: delayMins(destCall.bookedDeparture, destCall.effectiveDeparture),
      platform: destLoc.platform || null,
      isCancelled,
      cancelReasonCode,
      cancelReasonShortText,
      isEstimated: destCall.isEstimated,
    },
    status,
    searchUrl: `https://api.rtt.io/api/v1/json/search/${ORIGIN_CRS}/to/${DEST_CRS}/${chosenDate.replaceAll("-", "/")}/${BOOKED_DEPART_HHMM}`,
    detailUrl: `https://api.rtt.io/api/v1/json/service/${serviceUid}/${chosenDate.replaceAll("-", "/")}`,
  };

  fs.writeFileSync(OUT_STATUS, JSON.stringify(payload, null, 2), "utf8");
  appendHistory(payload);
  console.log(`Wrote ${OUT_STATUS} status=${status} date=${chosenDate}`);
}

function appendHistory(obj) {
  try {
    fs.appendFileSync(OUT_HISTORY, `${JSON.stringify(obj)}\n`, "utf8");
  } catch (e) {
    // Don’t fail the run just because history append failed.
    console.warn("WARN: could not append history.jsonl:", String(e));
  }
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
