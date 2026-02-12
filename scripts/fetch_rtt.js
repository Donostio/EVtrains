// scripts/fetch_rtt.js
// Fetches 07:44 Streatham→Wimbledon from Realtime Trains Pull API
// Switch rule: show TODAY until it has departed Streatham (or booked time if cancelled/unknown), then show TOMORROW.

const fs = require("fs");

const USER = process.env.RTT_USERNAME;
const PASS = process.env.RTT_PASSWORD;
const ORIGIN = process.env.ORIGIN_CRS || "STE";
const DEST = process.env.DEST_CRS || "WIM";
const GBTT = process.env.BOOKED_DEPART_HHMM || "0744";
const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";
const SWITCH_GRACE_MINS = Number.parseInt(process.env.SWITCH_GRACE_MINS || "2", 10);

if (!USER || !PASS) {
  console.error("Missing RTT_USERNAME / RTT_PASSWORD");
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, "0");
const hhmmToMinutes = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
const diffMinutes = (a, b) => hhmmToMinutes(a) - hhmmToMinutes(b);

function getLocalParts(date = new Date(), tz = LONDON_TZ) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
}

function localNowHHMM() {
  const lp = getLocalParts();
  return `${lp.hour}${lp.minute}`; // "HHMM"
}

function localYMD(offsetDays = 0) {
  const lp = getLocalParts();
  const y = +lp.year, m = +lp.month, d = +lp.day;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + offsetDays);
  const nlp = getLocalParts(dt);
  return { yyyy: nlp.year, mm: nlp.month, dd: nlp.day };
}

const b64 = Buffer.from(`${USER}:${PASS}`).toString("base64");
const headers = { Authorization: `Basic ${b64}`, Accept: "application/json" };

async function httpJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const findCall = (crs, service) => service?.locations?.find((l) => l.crs === crs) || null;

// 1) try filtered search (/to/); 2) fallback unfiltered
async function searchCandidates(datePath) {
  const filtered = `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}/${datePath}/${GBTT}`;
  try {
    const js = await httpJson(filtered);
    const svcs = (js?.services || []).filter((s) => s?.locationDetail?.gbttBookedDeparture === GBTT);
    return { urlTried: filtered, services: svcs, filtered: true };
  } catch {
    const unfiltered = `https://api.rtt.io/api/v1/json/search/${ORIGIN}/${datePath}/${GBTT}`;
    const js = await httpJson(unfiltered);
    const svcs = (js?.services || []).filter((s) => s?.locationDetail?.gbttBookedDeparture === GBTT);
    return { urlTried: unfiltered, services: svcs, filtered: false };
  }
}

function callInfo(call) {
  if (!call) return null;
  const bookedArr = call.gbttBookedArrival || null;
  const bookedDep = call.gbttBookedDeparture || null;
  const rtArr = call.realtimeArrival || null;
  const rtDep = call.realtimeDeparture || null;
  const arrDelay = rtArr && bookedArr ? diffMinutes(rtArr, bookedArr) : null;
  const depDelay = rtDep && bookedDep ? diffMinutes(rtDep, bookedDep) : null;
  return {
    bookedArrival: bookedArr,
    bookedDeparture: bookedDep,
    realtimeArrival: rtArr,
    realtimeDeparture: rtDep,
    arrivalDelayMins: arrDelay,
    departureDelayMins: depDelay,
    platform: call.platform || null,
    isCancelled: !!call.isCancelled,
    cancelReasonCode: call.cancelReasonCode || null,
    cancelReasonShortText: call.cancelReasonShortText || null,
  };
}

function overallStatus(origin, dest) {
  let overall = "on_time";
  if (origin?.isCancelled || dest?.isCancelled) overall = "cancelled";
  else if ((origin?.departureDelayMins ?? 0) > 0 || (dest?.arrivalDelayMins ?? 0) > 0) overall = "delayed";
  else if ((origin?.departureDelayMins ?? 0) < 0 || (dest?.arrivalDelayMins ?? 0) < 0) overall = "early";
  return overall;
}

async function fetchForDate(yyyy, mm, dd) {
  const datePath = `${yyyy}/${mm}/${dd}`;
  const nowLP = getLocalParts();
  const generatedAt = new Date(`${nowLP.year}-${nowLP.month}-${nowLP.day}T${nowLP.hour}:${nowLP.minute}:00`).toISOString();

  const { urlTried, services, filtered } = await searchCandidates(datePath);

  let chosen = null;
  if (filtered) {
    chosen = services.find((s) => s?.destination?.[0]?.crs === DEST) || services[0] || null;
  } else {
    for (const s of services.slice(0, 5)) {
      const { serviceUid, runDate } = s || {};
      if (!serviceUid || !runDate) continue;
      const detailUrl = `https://api.rtt.io/api/v1/json/service/${serviceUid}/${runDate.replace(/-/g, "/")}`;
      try {
        const detail = await httpJson(detailUrl);
        if (findCall(DEST, detail)) { chosen = s; break; }
      } catch { /* try next */ }
    }
    if (!chosen) chosen = services[0] || null;
  }

  if (!chosen) {
    return {
      generatedAt,
      date: `${yyyy}-${mm}-${dd}`,
      originCRS: ORIGIN,
      destinationCRS: DEST,
      gbttBookedDeparture: GBTT,
      status: "not_found",
      note: "Booked service not found in search results.",
      searchUrl: urlTried,
    };
  }

  const { serviceUid, runDate } = chosen;
  const detailUrl = `https://api.rtt.io/api/v1/json/service/${serviceUid}/${runDate.replace(/-/g, "/")}`;
  const detail = await httpJson(detailUrl);

  const origin = callInfo(findCall(ORIGIN, detail));
  const dest = callInfo(findCall(DEST, detail));
  const status = overallStatus(origin, dest);

  return {
    generatedAt,
    date: `${yyyy}-${mm}-${dd}`,
    serviceUid,
    runDate,
    originCRS: ORIGIN,
    destinationCRS: DEST,
    gbttBookedDeparture: GBTT,
    origin,
    destination: dest,
    status,
    searchUrl: filtered
      ? `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}/${datePath}/${GBTT}`
      : `https://api.rtt.io/api/v1/json/search/${ORIGIN}/${datePath}/${GBTT}`,
    detailUrl,
  };
}

function shouldSwitch(nowHHMM, todayPayload) {
  // If we can’t fetch today, we must show tomorrow.
  if (!todayPayload || todayPayload.status === "not_found") return true;

  const nowM = hhmmToMinutes(nowHHMM);

  const o = todayPayload.origin || {};
  const booked = o.bookedDeparture || GBTT;
  const cancelled = !!o.isCancelled || !!(todayPayload.destination && todayPayload.destination.isCancelled);

  // Threshold = actual departure if present (and not cancelled), else booked.
  const thresholdHHMM = cancelled ? booked : (o.realtimeDeparture || booked);
  const thresholdM = hhmmToMinutes(thresholdHHMM);

  return nowM >= (thresholdM + SWITCH_GRACE_MINS);
}

(async () => {
  try {
    const nowHHMM = localNowHHMM();
    const today = localYMD(0);
    const tomorrow = localYMD(1);

    const todayPayload = await fetchForDate(today.yyyy, today.mm, today.dd);
    const switchNow = shouldSwitch(nowHHMM, todayPayload);
    const payload = switchNow
      ? await fetchForDate(tomorrow.yyyy, tomorrow.mm, tomorrow.dd)
      : todayPayload;

    fs.writeFileSync("status.json", JSON.stringify(payload, null, 2));
    fs.appendFileSync("history.jsonl", JSON.stringify(payload) + "\n");
    console.log(`Saved status.json (${switchNow ? "tomorrow" : "today"} @ ${nowHHMM} local)`);
  } catch (e) {
    console.error(e);
    const msg = { error: String(e), when: new Date().toISOString() };
    fs.writeFileSync("status.json", JSON.stringify(msg, null, 2));
    fs.appendFileSync("history.jsonl", JSON.stringify(msg) + "\n");
    process.exit(1);
  }
})();
