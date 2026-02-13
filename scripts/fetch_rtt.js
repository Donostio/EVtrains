#!/usr/bin/env node
"use strict";

const fs = require("fs");

const RTT_BASE = "https://api.rtt.io/api/v1/json";
const originCRS = "STE";
const destinationCRS = "WIM";
const hhmm = "0744";

function todayInUKISO() {
  // YYYY/MM/DD in Europe/London
  const dt = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(dt)
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}/${parts.month}/${parts.day}`;
}

function ukDateDash(ymdSlash) {
  // YYYY/MM/DD -> YYYY-MM-DD
  const [y, m, d] = ymdSlash.split("/");
  return `${y}-${m}-${d}`;
}

function fmtHHMM(v) {
  if (!v || typeof v !== "string") return null;
  // RTT tends to give HHmm (e.g. "0741")
  if (/^\d{4}$/.test(v)) return `${v.slice(0, 2)}:${v.slice(2, 4)}`;
  return v;
}

function isLate(loc) {
  if (!loc) return false;

  // RTT’s own high-level signal
  const da = (loc.displayAs || "").toUpperCase();
  if (da.includes("LATE") || da.includes("DELAY")) return true;

  // RTT’s explicit lateness vs GBTT (minutes)
  const depLate = Number.isFinite(loc.realtimeGbttDepartureLateness)
    ? loc.realtimeGbttDepartureLateness > 0
    : false;
  const arrLate = Number.isFinite(loc.realtimeGbttArrivalLateness)
    ? loc.realtimeGbttArrivalLateness > 0
    : false;

  if (depLate || arrLate) return true;

  // Fallback: compare realtime vs booked
  if (loc.realtimeDeparture && loc.gbttBookedDeparture && loc.realtimeDeparture !== loc.gbttBookedDeparture)
    return true;
  if (loc.realtimeArrival && loc.gbttBookedArrival && loc.realtimeArrival !== loc.gbttBookedArrival)
    return true;

  return false;
}

async function rttGet(url) {
  const user = process.env.RTT_USER;
  const pass = process.env.RTT_PASS;
  if (!user || !pass) throw new Error("Missing RTT_USER/RTT_PASS secrets");

  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${body.slice(0, 400)}`);
  }
  return res.json();
}

(async () => {
  const ymdSlash = todayInUKISO(); // YYYY/MM/DD
  const ymdDash = ukDateDash(ymdSlash);

  const searchUrl = `${RTT_BASE}/search/${originCRS}/to/${destinationCRS}/${ymdSlash}/${hhmm}`;
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

  try {
    const search = await rttGet(searchUrl);

    const services = Array.isArray(search.services) ? search.services : [];
    if (!services.length) throw new Error(`No services in search response: ${searchUrl}`);

    // Prefer exact gbttBookedDeparture match; else first service
    const picked =
      services.find((s) => s.locationDetail?.gbttBookedDeparture === hhmm) || services[0];

    const serviceUid = picked.serviceUid;
    const runDate = picked.runDate || ymdDash;

    const detailUrl = `${RTT_BASE}/service/${serviceUid}/${runDate}`;
    const detail = await rttGet(detailUrl);

    const locs = Array.isArray(detail.locations) ? detail.locations : [];
    const origin = locs.find((l) => l.crs === originCRS);
    const destination = locs.find((l) => l.crs === destinationCRS);

    if (!origin || !destination) {
      throw new Error(
        `Could not find origin/destination in service locations. origin=${!!origin} destination=${!!destination}`
      );
    }

    const cancelled = !!origin.isCancelled || !!destination.isCancelled;

    const status =
      cancelled ? "cancelled" : isLate(origin) || isLate(destination) ? "delayed" : "on_time";

    // Choose displayed times without “calculating”
    const originDisplayDep =
      status === "delayed" && origin.realtimeDeparture ? origin.realtimeDeparture : origin.gbttBookedDeparture;

    const destDisplayArr =
      status === "delayed" && destination.realtimeArrival ? destination.realtimeArrival : destination.gbttBookedArrival;

    const out = {
      generatedAt,
      date: ymdDash,
      serviceUid,
      runDate,
      originCRS,
      destinationCRS,
      gbttBookedDeparture: hhmm,

      origin: {
        crs: origin.crs,
        bookedArrival: origin.gbttBookedArrival || null,
        bookedDeparture: origin.gbttBookedDeparture || null,
        realtimeArrival: origin.realtimeArrival || null,
        realtimeDeparture: origin.realtimeDeparture || null,
        realtimeArrivalActual: origin.realtimeArrivalActual ?? null,
        realtimeDepartureActual: origin.realtimeDepartureActual ?? null,
        realtimeGbttArrivalLateness: origin.realtimeGbttArrivalLateness ?? null,
        realtimeGbttDepartureLateness: origin.realtimeGbttDepartureLateness ?? null,
        displayAs: origin.displayAs || null,
        platform: origin.platform || null,
        isCancelled: origin.isCancelled || false,
        cancelReasonCode: origin.cancelReasonCode || null,
        cancelReasonShortText: origin.cancelReasonShortText || null,
        // For UI convenience:
        displayDeparture: originDisplayDep,
      },

      destination: {
        crs: destination.crs,
        bookedArrival: destination.gbttBookedArrival || null,
        bookedDeparture: destination.gbttBookedDeparture || null,
        realtimeArrival: destination.realtimeArrival || null,
        realtimeDeparture: destination.realtimeDeparture || null,
        realtimeArrivalActual: destination.realtimeArrivalActual ?? null,
        realtimeDepartureActual: destination.realtimeDepartureActual ?? null,
        realtimeGbttArrivalLateness: destination.realtimeGbttArrivalLateness ?? null,
        realtimeGbttDepartureLateness: destination.realtimeGbttDepartureLateness ?? null,
        displayAs: destination.displayAs || null,
        platform: destination.platform || null,
        isCancelled: destination.isCancelled || false,
        cancelReasonCode: destination.cancelReasonCode || null,
        cancelReasonShortText: destination.cancelReasonShortText || null,
        // For UI convenience:
        displayArrival: destDisplayArr,
      },

      status,
      searchUrl,
      detailUrl,

      // Optional UI helpers
      ui: {
        originDisplayDepartureHHMM: fmtHHMM(originDisplayDep),
        destDisplayArrivalHHMM: fmtHHMM(destDisplayArr),
      },
    };

    fs.writeFileSync("status.json", JSON.stringify(out, null, 2));
    fs.appendFileSync("history.jsonl", JSON.stringify(out) + "\n");
    console.log(`Wrote status.json for ${originCRS}->${destinationCRS} ${hhmm} (${status})`);
  } catch (err) {
    const e = { error: String(err && err.stack ? err.stack : err), when: new Date().toISOString() };
    fs.appendFileSync("history.jsonl", JSON.stringify(e) + "\n");
    console.error(e.error);
    process.exitCode = 1;
  }
})();
