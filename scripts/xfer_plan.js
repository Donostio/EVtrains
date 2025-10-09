#!/usr/bin/env node
/**
 * Build xfer.json for:
 *  - Direct SRC->IMW 07:25
 *  - Next three SRC->CLJ departures strictly after 07:25 (up to window end),
 *    each with up to two CLJ->IMW connections that depart >= 1 minute after CLJ arrival.
 *
 * Rolls to TOMORROW after 09:00 Europe/London (configurable via CUTOVER_LOCAL_TIME).
 *
 * Env:
 *  - RTT_USERNAME, RTT_PASSWORD   (required)
 *  - LONDON_TZ (default "Europe/London")
 *  - CUTOVER_LOCAL_TIME (default "09:00")
 *  - WINDOW_START (default "0725")
 *  - WINDOW_END   (default "0845")
 *
 * CRS:
 *  - SRC: Streatham Common ("SRC")
 *  - CLJ: Clapham Junction ("CLJ")
 *  - IMW: Imperial Wharf ("IMW")
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) {
  console.error('Missing RTT credentials (RTT_USERNAME/RTT_PASSWORD).');
  process.exit(1);
}

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const CUTOVER   = process.env.CUTOVER_LOCAL_TIME || '09:00';

const SRC = 'SRC';
const CLJ = 'CLJ';
const IMW = 'IMW';

const WINDOW_START = process.env.WINDOW_START || '0725'; // anchor direct
const WINDOW_END   = process.env.WINDOW_END   || '0845';

function toMinutes(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2),10); }
function ymdParts(dateStr){ const [y,m,d] = dateStr.split('-'); return {y,m,d}; }

function targetServiceDate(tz=LONDON_TZ, cut=CUTOVER) {
  const now = new Date();
  const hm = new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
  const todayISO = new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const today = new Date(todayISO);
  const base = (toMinutes(hm) >= toMinutes(cut)) ? new Date(today.getTime()+86400000) : today;
  return base.toISOString().slice(0,10);
}

function fetchJSON(url) {
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    const req = https.get(url, { headers:{ Authorization:`Basic ${auth}`, 'User-Agent':'rtt-gh-pages board' }}, res=>{
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

function statusFrom(originStop, destStop) {
  if (originStop?.isCancelled || destStop?.isCancelled) return 'cancelled';
  const depLate = originStop?.gbttBookedDeparture && originStop?.realtimeDeparture && originStop.realtimeDeparture !== originStop.gbttBookedDeparture;
  const arrLate = destStop?.gbttBookedArrival && destStop?.realtimeArrival && destStop.realtimeArrival !== destStop.gbttBookedArrival;
  return (depLate || arrLate) ? 'delayed' : 'on_time';
}

function findStop(detail, crs){ return (detail?.locations || []).find(l => l.crs === crs) || {}; }

async function getServiceDetail(uid, iso){
  const url = `https://api.rtt.io/api/v1/json/service/${uid}/${iso}`;
  return await fetchJSON(url);
}

async function searchFromTo(from, to, datePath, hhmm) {
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url = hhmm ? `${base}/${hhmm}` : base;
  const json = await fetchJSON(url);
  return json?.services || [];
}

(async ()=>{
  const iso = targetServiceDate();
  const {y,m,d} = ymdParts(iso);
  const datePath = `${y}/${m}/${d}`;

  const out = {
    generatedAt: new Date().toISOString(),
    datePath,
    window: { start: WINDOW_START, end: WINDOW_END },
    direct: null,
    legs: []
  };

  // -------- Direct SRC -> IMW at 07:25 --------
  try{
    const directServices = await searchFromTo(SRC, IMW, datePath, WINDOW_START);
    // look for the one that is exactly 07:25 at SRC if present, else the first service at/after
    let directSvc = directServices.find(s => (s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture) === WINDOW_START) || directServices[0];
    if (directSvc && directSvc.serviceUid){
      const detail = await getServiceDetail(directSvc.serviceUid, iso);
      const o = findStop(detail, SRC);
      const dStop = findStop(detail, IMW);
      out.direct = {
        status: statusFrom(o, dStop),
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        imwArr: dStop.gbttBookedArrival || null,
        imwArrReal: dStop.realtimeArrival || null,
        imwPlat: dStop.platform || null
      };
    }
  }catch(e){
    console.warn('Direct fetch error:', e.message);
  }

  // -------- First leg SRC -> CLJ AFTER 07:25 up to WINDOW_END --------
  try{
    // Pull from 07:25, then filter strictly after 07:25
    const all = await searchFromTo(SRC, CLJ, datePath, WINDOW_START);
    const after = all.filter(s=>{
      const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
      return dep && toMinutes(dep) > toMinutes(WINDOW_START) && toMinutes(dep) <= toMinutes(WINDOW_END);
    }).slice(0, 6); // fetch a few extras in case some have no valid connection

    const legs = [];
    for (const svc of after){
      if (!svc?.serviceUid) continue;
      const det = await getServiceDetail(svc.serviceUid, iso);
      const o = findStop(det, SRC);
      const a = findStop(det, CLJ);
      if (!o?.gbttBookedDeparture || !a?.gbttBookedArrival) continue;

      // Search connections from CLJ -> IMW that depart >= (arrReal||arrBooked)+1min
      const arrMin = toMinutes(a.realtimeArrival || a.gbttBookedArrival);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns = [];
      try{
        const cand = await searchFromTo(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length >= 2) break;
          if (!c?.serviceUid) continue;
          const cd = await getServiceDetail(c.serviceUid, iso);
          const cj = findStop(cd, CLJ);
          const iw = findStop(cd, IMW);
          if (!cj?.gbttBookedDeparture || !iw?.gbttBookedArrival) continue;

          // sanity: make sure dep >= arrival+1
          const depMin = toMinutes(cj.realtimeDeparture || cj.gbttBookedDeparture);
          if (depMin < arrMin + 1) continue;

          conns.push({
            status: statusFrom(cj, iw),
            cljDep: cj.gbttBookedDeparture || null,
            cljDepReal: cj.realtimeDeparture || null,
            cljPlat: cj.platform || null,
            imwArr: iw.gbttBookedArrival || null,
            imwArrReal: iw.realtimeArrival || null,
            imwPlat: iw.platform || null
          });
        }
      }catch(e){
        console.warn('Conn search error:', e.message);
      }

      legs.push({
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        cljArr: a.gbttBookedArrival || null,
        cljArrReal: a.realtimeArrival || null,
        cljPlatArr: a.platform || null,
        connections: conns
      });

      if (legs.length >= 3) break; // only keep next three
    }

    out.legs = legs;
  }catch(e){
    console.warn('First-leg fetch error:', e.message);
  }

  fs.writeFileSync('xfer.json', JSON.stringify(out,null,2));
  console.log('Wrote xfer.json for target date', iso);
})();
