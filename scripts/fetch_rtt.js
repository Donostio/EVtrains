// scripts/fetch_rtt.js
// Fetches 07:44 Streatham→Wimbledon from Realtime Trains Pull API

const fs = require("fs");

const USER = process.env.RTT_USERNAME;
const PASS = process.env.RTT_PASSWORD;
const ORIGIN = process.env.ORIGIN_CRS || "STE";
const DEST = process.env.DEST_CRS || "WIM";
const GBTT = process.env.BOOKED_DEPART_HHMM || "0744";
const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";

const pad = (n) => String(n).padStart(2, "0");
const hhmmToMinutes = (s) => parseInt(s.slice(0, 2), 10) * 60 + parseInt(s.slice(2), 10);
const diffMinutes = (a, b) => hhmmToMinutes(a) - hhmmToMinutes(b);

function getLocalParts(date = new Date(), tz = LONDON_TZ) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
}

// Today until 17:00 local, then tomorrow
function chooseServiceDate() {
  const lp = getLocalParts();
  let y = +lp.year, m = +lp.month, d = +lp.day;
  if (+lp.hour >= 17) {
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + 1);
    const nlp = getLocalParts(dt);
    y = +nlp.year; m = +nlp.month; d = +nlp.day;
  }
  return { yyyy: String(y), mm: pad(m), dd: pad(d) };
}

const { yyyy, mm, dd } = chooseServiceDate();
const datePath = `${yyyy}/${mm}/${dd}`;                  // <- slashes for RTT
const nowLP = getLocalParts();
const generatedAt = new Date(`${nowLP.year}-${nowLP.month}-${nowLP.day}T${nowLP.hour}:${nowLP.minute}:00`).toISOString();

const b64 = Buffer.from(`${USER}:${PASS}`).toString("base64");
const headers = { Authorization: `Basic ${b64}`, Accept: "application/json" };

async function httpJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const findCall = (crs, service) => service?.locations?.find((l) => l.crs === crs) || null;

// 1) try filtered search (/to/ before date+time); 2) fallback to unfiltered
async function searchCandidates() {
  const filtered = `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}/${datePath}/${GBTT}`;
  try {
    const js = await httpJson(filtered);
    const svcs = (js?.services || []).filter(s => s?.locationDetail?.gbttBookedDeparture === GBTT);
    return { urlTried: filtered, services: svcs, filtered: true };
  } catch {
    const unfiltered = `https://api.rtt.io/api/v1/json/search/${ORIGIN}/${datePath}/${GBTT}`;
    const js = await httpJson(unfiltered);
    const svcs = (js?.services || []).filter(s => s?.locationDetail?.gbttBookedDeparture === GBTT);
    return { urlTried: unfiltered, services: svcs, filtered: false };
  }
}

(async () => {
  try {
    if (!USER || !PASS) throw new Error("Missing RTT_USERNAME or RTT_PASSWORD env");

    const { urlTried, services, filtered } = await searchCandidates();

    let chosen = null;
    if (filtered) {
      chosen = services.find(s => s?.destination?.[0]?.crs === DEST) || services[0] || null;
    } else {
      // Probe a few candidates to ensure the service actually calls at DEST
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
      const payload = {
        generatedAt, date: `${yyyy}-${mm}-${dd}`,
        originCRS: ORIGIN, destinationCRS: DEST, gbttBookedDeparture: GBTT,
        status: "not_found", note: "Booked service not found in search results.",
        searchUrl: urlTried
      };
      fs.writeFileSync("status.json", JSON.stringify(payload, null, 2));
      fs.appendFileSync("history.jsonl", JSON.stringify(payload) + "\n");
      console.log("Saved status.json (not_found).");
      return;
    }

    const { serviceUid, runDate } = chosen;                   // runDate = YYYY-MM-DD (from API)
    const detailUrl = `https://api.rtt.io/api/v1/json/service/${serviceUid}/${runDate.replace(/-/g, "/")}`; // <- slashes
    const detail = await httpJson(detailUrl);

    function callInfo(call) {
      if (!call) return null;
      const bookedArr = call.gbttBookedArrival || null;
      const bookedDep = call.gbttBookedDeparture || null;
      const rtArr = call.realtimeArrival || null;
      const rtDep = call.realtimeDeparture || null;
      const arrDelay = rtArr && bookedArr ? diffMinutes(rtArr, bookedArr) : null;
      const depDelay = rtDep && bookedDep ? diffMinutes(rtDep, bookedDep) : null;
      return {
        bookedArrival: bookedArr, bookedDeparture: bookedDep,
        realtimeArrival: rtArr, realtimeDeparture: rtDep,
        arrivalDelayMins: arrDelay, departureDelayMins: depDelay,
        platform: call.platform || null,
        isCancelled: !!call.isCancelled,
        cancelReasonCode: call.cancelReasonCode || null,
        cancelReasonShortText: call.cancelReasonShortText || null,
      };
    }

    const origin = callInfo(findCall(ORIGIN, detail));
    const dest = callInfo(findCall(DEST, detail));

    let overall = "on_time";
    if (origin?.isCancelled || dest?.isCancelled) overall = "cancelled";
    else if ((origin?.departureDelayMins ?? 0) > 0 || (dest?.arrivalDelayMins ?? 0) > 0) overall = "delayed";
    else if ((origin?.departureDelayMins ?? 0) < 0 || (dest?.arrivalDelayMins ?? 0) < 0) overall = "early";

    const payload = {
      generatedAt, date: `${yyyy}-${mm}-${dd}`,
      serviceUid, runDate,
      originCRS: ORIGIN, destinationCRS: DEST, gbttBookedDeparture: GBTT,
      origin, destination: dest, status: overall,
      searchUrl: filtered
        ? `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}/${datePath}/${GBTT}`
        : `https://api.rtt.io/api/v1/json/search/${ORIGIN}/${datePath}/${GBTT}`,
      detailUrl
    };

    fs.writeFileSync("status.json", JSON.stringify(payload, null, 2));
    fs.appendFileSync("history.jsonl", JSON.stringify(payload) + "\n");
    console.log("Saved status.json");
  } catch (e) {
    console.error(e);
    const msg = { error: String(e), when: new Date().toISOString() };
    fs.writeFileSync("status.json", JSON.stringify(msg, null, 2));
    fs.appendFileSync("history.jsonl", JSON.stringify(msg) + "\n");
  }
})();
