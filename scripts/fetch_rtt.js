#!/usr/bin/env node
/**
 * Build status.json for the fixed STE -> WIM 07:44 service.
 * Rolls to TOMORROW after 09:00 Europe/London (configurable via CUTOVER_LOCAL_TIME).
 *
 * Env:
 *  - RTT_USERNAME, RTT_PASSWORD   (required)
 *  - ORIGIN_CRS (default "STE")
 *  - DEST_CRS   (default "WIM")
 *  - BOOKED_DEPART_HHMM (default "0744")
 *  - LONDON_TZ (default "Europe/London")
 *  - CUTOVER_LOCAL_TIME (default "09:00")
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) {
  console.error('Missing RTT credentials (RTT_USERNAME/RTT_PASSWORD).');
  process.exit(1);
}

const ORIGIN = process.env.ORIGIN_CRS || 'STE';
const DEST   = process.env.DEST_CRS   || 'WIM';
const HHMM   = process.env.BOOKED_DEPART_HHMM || '0744';
const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const CUTOVER   = process.env.CUTOVER_LOCAL_TIME || '09:00';

function toMinutes(hhmm) {
  return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2),10);
}
function ymdParts(dateStr) {
  const [y,m,d] = dateStr.split('-'); return {y,m,d};
}
function isoShiftDays(iso, days) {
  const dt = new Date(iso + 'T00:00:00Z'); // treat as UTC midnight
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0,10);
}
function currentHM(tz=LONDON_TZ){
  return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
}
function targetServiceDate(tz=LONDON_TZ, cut=CUTOVER) {
  const hm = currentHM(tz);
  const todayISO = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const today = new Date(todayISO); // parses as UTC midnight; fine since we only need yyyy-mm-dd
  const base = (toMinutes(hm) >= toMinutes(cut)) ? new Date(today.getTime()+86400000) : today;
  return base.toISOString().slice(0,10);
}

function fetchJSON(url) {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    const req = https.get(url, { headers: { Authorization:`Basic ${auth}`, 'User-Agent':'rtt-gh-pages board' }}, res => {
      let data=''; res.on('data', d=>data+=d);
      res.on('end', ()=>{
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        }
        try { resolve(JSON.parse(data)); } catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function pickStatus(o, d) {
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depB = o?.gbttBookedDeparture, depR = o?.realtimeDeparture;
  const arrB = d?.gbttBookedArrival,   arrR = d?.realtimeArrival;
  const depLate = depB && depR && depR !== depB;
  const arrLate = arrB && arrR && arrR !== arrB;
  return (depLate || arrLate) ? 'delayed' : 'on_time';
}

(async ()=>{
  const iso = targetServiceDate();
  const {y, m, d: dd} = ymdParts(iso);
  const datePath = `${y}/${m}/${dd}`;

  const searchUrl = `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}/${datePath}/${HHMM}`;
  let search;
  try {
    search = await fetchJSON(searchUrl);
  } catch (e) {
    const err = { error: String(e), when: new Date().toISOString() };
    fs.writeFileSync('status.json', JSON.stringify(err,null,2));
    console.error(err);
    process.exit(0);
  }

  const services = search?.services || [];
  const svc = services.find(s => {
    const bd = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
    return bd === HHMM;
  }) || services[0];

  if (!svc || !svc.serviceUid) {
    const err = { error:`No service found at ${ORIGIN}->${DEST} ${datePath} ${HHMM}`, when:new Date().toISOString() };
    fs.writeFileSync('status.json', JSON.stringify(err,null,2));
    console.warn(err);
    process.exit(0);
  }

  // Prefer the runDate RTT gives us; fallback to iso
  const svcRunISO = (svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate)) ? svc.runDate : iso;

  async function getDetailWithFallback(uid, primaryISO){
    const makeUrl = (u, d) => `https://api.rtt.io/api/v1/json/service/${u}/${d}`;
    try {
      return await fetchJSON(makeUrl(uid, primaryISO));
    } catch (e) {
      const msg = String(e);
      // If 404, try adjacent day: after cutover -> next day; before cutover -> previous day
      if (msg.includes('HTTP 404')) {
        const hm = currentHM(LONDON_TZ);
        const altISO = (toMinutes(hm) >= toMinutes(CUTOVER))
          ? isoShiftDays(primaryISO, +1)
          : isoShiftDays(primaryISO, -1);
        try {
          return await fetchJSON(makeUrl(uid, altISO));
        } catch (e2) {
          throw e; // bubble original 404
        }
      }
      throw e;
    }
  }

  let detail;
  try {
    detail = await getDetailWithFallback(svc.serviceUid, svcRunISO);
  } catch(e){
    const err = { error:String(e), when:new Date().toISOString(), triedDate: svcRunISO };
    fs.writeFileSync('status.json', JSON.stringify(err,null,2));
    console.error(err);
    process.exit(0);
  }

  const findStop = (crs) => (detail?.locations || []).find(l => l.crs === crs);

  const o = findStop(ORIGIN) || {};
  const dest = findStop(DEST) || {};

  const out = {
    generatedAt: new Date().toISOString(),
    date: svcRunISO,
    serviceUid: svc.serviceUid,
    runDate: svcRunISO,
    originCRS: ORIGIN,
    destinationCRS: DEST,
    gbttBookedDeparture: HHMM,
    origin: {
      bookedArrival:   o.gbttBookedArrival   || null,
      bookedDeparture: o.gbttBookedDeparture || null,
      realtimeArrival: o.realtimeArrival     || null,
      realtimeDeparture:o.realtimeDeparture  || null,
      arrivalDelayMins: o.realtimeArrival && o.gbttBookedArrival ? (toMinutes(o.realtimeArrival)-toMinutes(o.gbttBookedArrival)) : null,
      departureDelayMins:o.realtimeDeparture && o.gbttBookedDeparture ? (toMinutes(o.realtimeDeparture)-toMinutes(o.gbttBookedDeparture)) : null,
      platform: o.platform || null,
      isCancelled: !!o.isCancelled,
      cancelReasonCode: o.cancelReasonCode || null,
      cancelReasonShortText: o.cancelReasonShortText || null
    },
    destination: {
      bookedArrival:   dest.gbttBookedArrival   || null,
      bookedDeparture: dest.gbttBookedDeparture || null,
      realtimeArrival: dest.realtimeArrival     || null,
      realtimeDeparture:dest.realtimeDeparture  || null,
      arrivalDelayMins: dest.realtimeArrival && dest.gbttBookedArrival ? (toMinutes(dest.realtimeArrival)-toMinutes(dest.gbttBookedArrival)) : null,
      departureDelayMins:dest.realtimeDeparture && dest.gbttBookedDeparture ? (toMinutes(dest.realtimeDeparture)-toMinutes(dest.gbttBookedDeparture)) : null,
      platform: dest.platform || null,
      isCancelled: !!dest.isCancelled,
      cancelReasonCode: dest.cancelReasonCode || null,
      cancelReasonShortText: dest.cancelReasonShortText || null
    },
    status: pickStatus(o, dest),
    searchUrl,
    detailTriedDate: svcRunISO
  };

  fs.writeFileSync('status.json', JSON.stringify(out,null,2));
  console.log('Wrote status.json for', ORIGIN,'→',DEST, HHMM, 'runDate', svcRunISO);
})();
