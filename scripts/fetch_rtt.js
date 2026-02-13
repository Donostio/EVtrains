// scripts/fetch_rtt.js
// Fetch a specific booked service (e.g. STE->WIM 0744) from RealtimeTrains and write status.json.
// Also appends a compact line to history.jsonl on success/error.

const fs = require("fs");

const ORIGIN_CRS = (process.env.ORIGIN_CRS || "").trim();
const DEST_CRS = (process.env.DEST_CRS || "").trim();

// Accept either name (you previously used DEP_TIME; current script wanted BOOKED_DEPART_HHMM)
const BOOKED_DEPART_HHMM = (process.env.BOOKED_DEPART_HHMM || process.env.DEP_TIME || "").trim();

const RTT_USERNAME = process.env.RTT_USERNAME;
const RTT_PASSWORD = process.env.RTT_PASSWORD;

const VERBOSE = String(process.env.VERBOSE || "false").toLowerCase() === "true";

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

if (!ORIGIN_CRS) die("Missing env ORIGIN_CRS");
if (!DEST_CRS) die("Missing env DEST_CRS");
if (!BOOKED_DEPART_HHMM) die("Missing env BOOKED_DEPART_HHMM (or DEP_TIME)");
if (!RTT_USERNAME || !RTT_PASSWORD) die("Missing RTT_USERNAME / RTT_PASSWORD secrets");

function londonYMD(offsetDays = 0) {
  const now = new Date();
  // Create a date in Europe/London by formatting parts via Intl
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;

  // Construct a Date from the London "today", then add offset days
  const base = new Date(`${y}-${m}-${d}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + offsetDays);

  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function authHeader(user, pass) {
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

async function rttFetchJson(url) {
  const res = await fetch(url, {
    headers: { Authorization: authHeader(RTT_USERNAME, RTT_PASSWORD) },
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = text.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url} :: ${snippet}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response for ${url} :: ${text.slice(0, 300).replace(/\s+/g, " ")}`);
  }
}

function hhmmToMins(hhmm) {
  if (!hhmm || hhmm.length < 3) return null;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(2, 4));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minsToHHMM(mins) {
  mins = ((mins % (24 * 60)) + (24 * 60)) % (24 * 60);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}${m}`;
}

function appendHistory(obj) {
  try {
    fs.appendFileSync("history.jsonl", JSON.stringify(obj) + "\n");
  } catch (_) {
    // non-fatal
  }
}

function pickLocation(call, crs) {
  if (!call || !Array.isArray(call.locations)) return null;
  const want = String(crs || "").toUpperCase();
  return call.locations.find(l => String(l.crs || "").toUpperCase() === want) || null;
}

function locationTimes(loc) {
  const bookedArrival = loc.gbttBookedArrival || loc.bookedArrival || null;
  const bookedDeparture = loc.gbttBookedDeparture || loc.bookedDeparture || null;

  const rtArrival = loc.realtimeArrival || loc.actualArrival || loc.publicArrival || null;
  const rtDeparture = loc.realtimeDeparture || loc.actualDeparture || loc.publicDeparture || null;

  return { bookedArrival, bookedDeparture, rtArrival, rtDeparture };
}

function delayMins(bookedHHMM, rtHHMM) {
  const b = hhmmToMins(bookedHHMM);
  const r = hhmmToMins(rtHHMM);
  if (b == null || r == null) return null;
  return r - b;
}

function statusFromDelays(depDelay, arrDelay, cancelled) {
  if (cancelled) return "cancelled";
  const d = depDelay ?? 0;
  const a = arrDelay ?? 0;
  const worst = Math.max(d, a);
  if (worst >= 1) return "delayed";
  return "on_time";
}

(async () => {
  const runDate = londonYMD(0);

  const yyyy = runDate.slice(0, 4);
  const mm = runDate.slice(5, 7);
  const dd = runDate.slice(8, 10);

  const searchUrl = `https://api.rtt.io/api/v1/json/search/${ORIGIN_CRS}/to/${DEST_CRS}/${yyyy}/${mm}/${dd}/${BOOKED_DEPART_HHMM}`;

  try {
    if (VERBOSE) console.log(`RTT search: ${searchUrl}`);

    const search = await rttFetchJson(searchUrl);

    const services = (search && (search.services || search.service || search.Services)) || search.services;
    if (!Array.isArray(services) || services.length === 0) {
      throw new Error(`No services found in search response for ${ORIGIN_CRS}->${DEST_CRS} ${runDate} ${BOOKED_DEPART_HHMM}`);
    }

    // Best effort: pick first service. (For a single booked-time search, RTT usually returns the intended one.)
    const svc = services[0];
    const serviceUid = svc.serviceUid || svc.serviceUID || svc.uid || null;
    if (!serviceUid) throw new Error("Search response missing serviceUid");

    const detailUrl = `https://api.rtt.io/api/v1/json/service/${serviceUid}/${yyyy}/${mm}/${dd}`;
    if (VERBOSE) console.log(`RTT detail: ${detailUrl}`);

    const detail = await rttFetchJson(detailUrl);

    const originLoc = pickLocation(detail, ORIGIN_CRS);
    const destLoc = pickLocation(detail, DEST_CRS);
    if (!originLoc || !destLoc) throw new Error("Detail response missing origin/destination locations");

    const o = locationTimes(originLoc);
    const d = locationTimes(destLoc);

    const depDelayMins = delayMins(o.bookedDeparture, o.rtDeparture);
    const arrDelayMins = delayMins(d.bookedArrival, d.rtArrival);

    const isCancelled =
      Boolean(originLoc.isCancelled) ||
      Boolean(destLoc.isCancelled) ||
      Boolean(detail.isCancelled) ||
      false;

    const platformFrom = originLoc.platform || originLoc.plat || null;
    const platformTo = destLoc.platform || destLoc.plat || null;

    // IMPORTANT: expose both booked and realtime HHMM
    const payload = {
      generatedAt: new Date().toISOString(),
      date: runDate,
      serviceUid,
      runDate,
      originCRS: ORIGIN_CRS,
      destinationCRS: DEST_CRS,
      gbttBookedDeparture: BOOKED_DEPART_HHMM,

      origin: {
        bookedArrival: o.bookedArrival,
        bookedDeparture: o.bookedDeparture,
        realtimeArrival: o.rtArrival,
        realtimeDeparture: o.rtDeparture,
        arrivalDelayMins: delayMins(o.bookedArrival, o.rtArrival),
        departureDelayMins: depDelayMins,
        platform: platformFrom,
        isCancelled,
      },

      destination: {
        bookedArrival: d.bookedArrival,
        bookedDeparture: d.bookedDeparture,
        realtimeArrival: d.rtArrival,
        realtimeDeparture: d.rtDeparture,
        arrivalDelayMins: arrDelayMins,
        departureDelayMins: delayMins(d.bookedDeparture, d.rtDeparture),
        platform: platformTo,
        isCancelled,
      },

      status: statusFromDelays(depDelayMins, arrDelayMins, isCancelled),
      searchUrl,
      detailUrl,
    };

    fs.writeFileSync("status.json", JSON.stringify(payload, null, 2));

    appendHistory({
      generatedAt: payload.generatedAt,
      date: payload.date,
      serviceUid: payload.serviceUid,
      runDate: payload.runDate,
      originCRS: payload.originCRS,
      destinationCRS: payload.destinationCRS,
      gbttBookedDeparture: payload.gbttBookedDeparture,
      origin: payload.origin,
      destination: payload.destination,
      status: payload.status,
      searchUrl: payload.searchUrl,
      detailUrl: payload.detailUrl,
    });

    if (VERBOSE) {
      console.log(
        `Wrote status.json: ${ORIGIN_CRS}->${DEST_CRS} booked ${o.bookedDeparture} real ${o.rtDeparture} status=${payload.status}`
      );
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    console.error(msg);

    appendHistory({
      error: msg,
      when: new Date().toISOString(),
    });

    // Also write a minimal status.json so the page can show "No data" deterministically
    try {
      fs.writeFileSync(
        "status.json",
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            error: msg,
            originCRS: ORIGIN_CRS,
            destinationCRS: DEST_CRS,
            date: londonYMD(0),
          },
          null,
          2
        )
      );
    } catch (_) {}

    process.exit(1);
  }
})();
