/**
 * Build transfer options for:
 *  - SRC -> CLJ
 *  - CLJ -> IMW
 * and write xfer.json
 *
 * Key fix: widen the back-scan window so early trains (e.g. 07:25) aren’t missed.
 *
 * Env:
 *  - RTT_USER / RTT_PASS (preferred) OR RTT_USERNAME / RTT_PASSWORD
 *  - LONDON_TZ (default Europe/London)
 *  - WINDOW_BACK_MINS (default 40)  <-- important
 *  - WINDOW_FWD_MINS (default 180)
 */

const fs = require("fs");
const path = require("path");

const OUT_XFER = path.join(process.cwd(), "xfer.json");

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

function londonNow(tz = "Europe/London") {
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

function minsToHHMM(mins) {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}${m}`;
}

async function rttFetchJson(url, user, pass) {
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${txt.slice(0, 500)}`);
  }
  return res.json();
}

function pickBestTime(loc, which) {
  // which: "dep" or "arr"
  // Use actual if present, else realtime, else booked
  if (which === "dep") return loc.actualDeparture || loc.realtimeDeparture || loc.gbttBookedDeparture || null;
  return loc.actualArrival || loc.realtimeArrival || loc.gbttBookedArrival || null;
}

async function fetchLegServices({ from, to, dateParts, startHHMM, user, pass }) {
  const { yyyy, mm, dd } = dateParts;
  const url = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${yyyy}/${mm}/${dd}/${startHHMM}`;
  const j = await rttFetchJson(url, user, pass);
  const services = Array.isArray(j.services) ? j.services : [];
  return { url, services };
}

async function getServiceDetail({ uid, dateParts, user, pass }) {
  const { yyyy, mm, dd } = dateParts;
  const url = `https://api.rtt.io/api/v1/json/service/${uid}/${yyyy}/${mm}/${dd}`;
  const j = await rttFetchJson(url, user, pass);
  return { url, detail: j };
}

function getLoc(detail, crs) {
  const locs = Array.isArray(detail.locations) ? detail.locations : [];
  return locs.find((l) => l?.crs === crs);
}

function summariseService({ detail, from, to }) {
  const a = getLoc(detail, from);
  const b = getLoc(detail, to);
  if (!a || !b) return null;

  const dep = pickBestTime(a, "dep");
  const arr = pickBestTime(b, "arr");

  const platformFrom = a.platform || null;
  const platformTo = b.platform || null;

  const isCancelled = Boolean(a.isCancelled) || Boolean(b.isCancelled) || Boolean(detail.isCancelled);

  // delay mins from booked, based on the *effective* time RTT gives you
  const depDelay =
    (a.gbttBookedDeparture && dep) ? hmToMins(dep) - hmToMins(a.gbttBookedDeparture) : null;
  const arrDelay =
    (b.gbttBookedArrival && arr) ? hmToMins(arr) - hmToMins(b.gbttBookedArrival) : null;

  const status = isCancelled ? "cancelled" : ((depDelay ?? 0) > 0 || (arrDelay ?? 0) > 0 ? "delayed" : "on_time");

  return {
    serviceUid: detail.serviceUid || null,
    from,
    to,
    dep,
    arr,
    depDelayMins: depDelay,
    arrDelayMins: arrDelay,
    platformFrom,
    platformTo,
    status,
  };
}

async function build() {
  const { user, pass } = envCreds();

  const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";
  const backMins = Number(process.env.WINDOW_BACK_MINS || "40"); // IMPORTANT: was too small before
  const fwdMins = Number(process.env.WINDOW_FWD_MINS || "180");

  const now = londonNow(LONDON_TZ);
  const nowMins = Number(now.hh) * 60 + Number(now.mi);
  const startMins = Math.max(0, nowMins - backMins);
  const startHHMM = minsToHHMM(startMins);

  const dateParts = { yyyy: now.yyyy, mm: now.mm, dd: now.dd };

  // Legs you care about
  const LEG1 = { from: "SRC", to: "CLJ", label: "SRC-CLJ" };
  const LEG2 = { from: "CLJ", to: "IMW", label: "CLJ-IMW" };

  // Fetch search slices
  const leg1Search = await fetchLegServices({ ...LEG1, dateParts, startHHMM, user, pass });
  const leg2Search = await fetchLegServices({ ...LEG2, dateParts, startHHMM, user, pass });

  // Pull details (limit to reasonable size)
  const leg1Uids = leg1Search.services.map((s) => s.serviceUid).filter(Boolean).slice(0, 25);
  const leg2Uids = leg2Search.services.map((s) => s.serviceUid).filter(Boolean).slice(0, 25);

  const leg1Details = await Promise.all(
    leg1Uids.map((uid) => getServiceDetail({ uid, dateParts, user, pass }).then((r) => r.detail).catch(() => null))
  );
  const leg2Details = await Promise.all(
    leg2Uids.map((uid) => getServiceDetail({ uid, dateParts, user, pass }).then((r) => r.detail).catch(() => null))
  );

  const leg1 = leg1Details
    .filter(Boolean)
    .map((d) => summariseService({ detail: d, from: LEG1.from, to: LEG1.to }))
    .filter(Boolean)
    .filter((s) => s.dep && s.arr)
    .filter((s) => {
      const t = hmToMins(s.dep);
      return t >= startMins && t <= nowMins + fwdMins;
    })
    .sort((a, b) => hmToMins(a.dep) - hmToMins(b.dep));

  const leg2 = leg2Details
    .filter(Boolean)
    .map((d) => summariseService({ detail: d, from: LEG2.from, to: LEG2.to }))
    .filter(Boolean)
    .filter((s) => s.dep && s.arr)
    .filter((s) => {
      const t = hmToMins(s.dep);
      return t >= startMins && t <= nowMins + fwdMins;
    })
    .sort((a, b) => hmToMins(a.dep) - hmToMins(b.dep));

  // Build transfer pairs where CLJ wait is sensible (>=2 mins and <=25 mins)
  const options = [];
  for (const a of leg1) {
    const arrCLJ = hmToMins(a.arr);
    for (const b of leg2) {
      const depCLJ = hmToMins(b.dep);
      const wait = depCLJ - arrCLJ;
      if (wait >= 2 && wait <= 25) {
        options.push({
          src_clj: a,
          clj_imw: b,
          waitMins: wait,
          // helpful for display:
          change: {
            fromPlatform: a.platformTo,
            toPlatform: b.platformFrom,
          },
        });
      }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    date: `${dateParts.yyyy}-${dateParts.mm}-${dateParts.dd}`,
    window: {
      tz: LONDON_TZ,
      startHHMM,
      backMins,
      fwdMins,
    },
    searches: {
      src_clj: leg1Search.url,
      clj_imw: leg2Search.url,
    },
    legs: { src_clj: leg1, clj_imw: leg2 },
    transfers: options.sort((x, y) => hmToMins(x.src_clj.dep) - hmToMins(y.src_clj.dep)),
  };

  fs.writeFileSync(OUT_XFER, JSON.stringify(payload, null, 2), "utf8");
  console.log(`Wrote ${OUT_XFER}: leg1=${leg1.length} leg2=${leg2.length} xfers=${options.length} start=${startHHMM}`);
}

build().catch((e) => {
  console.error(String(e));
  process.exit(2);
});
