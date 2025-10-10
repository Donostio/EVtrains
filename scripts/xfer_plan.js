#!/usr/bin/env node
/**
 * xfer.json (ROLLED BACK, minimal):
 *  - TODAY only
 *  - Direct SRC->IMW at 07:25
 *  - Next three SRC->CLJ strictly AFTER 07:25 and <= 08:45
 *  - For each first leg, up to two CLJ->IMW connections departing >= 1 min after CLJ arrival
 *  - RID-first for detail; fallback to service/{uid}/{date} with ±1 day retry
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) {
  console.error('Missing RTT credentials'); process.exit(1);
}

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';

// CRS codes
const SRC = 'SRC';
const CLJ = 'CLJ';
const IMW = 'IMW';

// Window (booked times)
const WINDOW_START = process.env.WINDOW_START || '0725'; // anchor
const WINDOW_END   = process.env.WINDOW_END   || '0845'; // cut-off

/* ------------------ time/date helpers (TODAY ONLY) ------------------ */
function toMin(hhmm) {
  return parseInt(hhmm.slice(0,2),10) * 60 + parseInt(hhmm.slice(2,4),10);
}
function localYMD(tz) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p=>p.type==='year').value;
  const m = parts.find(p=>p.type==='month').value;
  const d = parts.find(p=>p.type==='day').value;
  return `${y}-${m}-${d}`;
}
function todayISO() { return localYMD(LONDON_TZ); }
function isoShiftDays(iso, days){
  const dt = new Date(iso + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0,10);
}

/* ------------------ HTTP helper ------------------ */
function fetchJSON(url){
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    https.get(url, { headers:{
      Authorization: `Basic ${auth}`,
      'User-Agent': 'ev-trains board'
    }}, res => {
      let data='';
      res.on('data', d => data += d);
      res.on('end', ()=>{
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        }
        try { resolve(JSON.parse(data)); } catch(e){ reject(e); }
      });
    }).on('error', reject);
  });
}

/* ------------------ RTT helpers ------------------ */
function statusFrom(o,d){
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture !== o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival !== d.gbttBookedArrival;
  return (depLate || arrLate) ? 'delayed' : 'on_time';
}
const findStop = (detail, crs) => (detail?.locations || []).find(l => l.crs === crs) || {};

async function detailBySvc(svc, iso){
  // Prefer detail by RID (date-less)
  if (svc.rid){
    try { return await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`); }
    catch(_e) { /* fall back */ }
  }
  // Fallback: UID + runDate, retry ±1 day on 404
  const runISO = (svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate)) ? svc.runDate : iso;
  const mk = (u,d)=>`https://api.rtt.io/api/v1/json/service/${u}/${d}`;
  try { return await fetchJSON(mk(svc.serviceUid, runISO)); }
  catch(e){
    if (!String(e).includes('HTTP 404')) throw e;
    for (const delta of [+1,-1]){
      try { return await fetchJSON(mk(svc.serviceUid, isoShiftDays(runISO, delta))); }
      catch(_e) {}
    }
    throw e;
  }
}

async function search(from,to,datePath,hhmm){
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url  = hhmm ? `${base}/${hhmm}` : base;
  const js = await fetchJSON(url);
  return js?.services || [];
}

/* ------------------ main ------------------ */
(async ()=>{
  const iso = todayISO();                      // TODAY ONLY
  const [y,m,d] = iso.split('-');
  const datePath = `${y}/${m}/${d}`;
  console.log(`[xfer_plan] today=${iso} window=${WINDOW_START}-${WINDOW_END}`);

  const out = {
    generatedAt: new Date().toISOString(),
    datePath: `${y}/${m}/${d}`,
    window: { start: WINDOW_START, end: WINDOW_END },
    direct: null,
    legs: []
  };

  // ---- Direct SRC -> IMW at 07:25 (today) ----
  try{
    const svcs = await search(SRC, IMW, datePath, WINDOW_START);
    const svc  = svcs.find(s => (s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture) === WINDOW_START) || svcs[0];
    if (svc){
      const det = await detailBySvc(svc, iso);
      const o  = findStop(det, SRC);
      const iw = findStop(det, IMW);
      out.direct = {
        status: statusFrom(o, iw),
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        imwArr: iw.gbttBookedArrival || null,
        imwArrReal: iw.realtimeArrival || null,
        imwPlat: iw.platform || null
      };
    }
  }catch(e){
    console.warn('Direct fetch error:', String(e));
  }

  // ---- First legs: next three SRC -> CLJ strictly AFTER 07:25, <= 08:45 (today) ----
  try{
    const all = await search(SRC, CLJ, datePath, WINDOW_START);
    const after = all.filter(s=>{
      const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
      return dep && toMin(dep) > toMin(WINDOW_START) && toMin(dep) <= toMin(WINDOW_END);
    });

    const legs = [];
    for (const svc of after){
      if (!svc?.serviceUid) continue;

      let det;
      try { det = await detailBySvc(svc, iso); }
      catch(e){ console.warn('First-leg detail skip:', String(e)); continue; }

      const o  = findStop(det, SRC);
      const cj = findStop(det, CLJ);
      if (!o?.gbttBookedDeparture || !cj?.gbttBookedArrival) continue;

      // Connections: CLJ -> IMW; depart >= (arrReal||arrBooked) + 1 min
      const arrBookedOrReal = cj.realtimeArrival || cj.gbttBookedArrival;
      const arrMin = toMin(arrBookedOrReal);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns = [];
      try{
        const cand = await search(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length >= 2) break;
          if (!c?.serviceUid) continue;

          let cd; try { cd = await detailBySvc(c, iso); } catch(_e){ continue; }
          const cjs = findStop(cd, CLJ);
          const imw = findStop(cd, IMW);
          if (!cjs?.gbttBookedDeparture || !imw?.gbttBookedArrival) continue;

          const depMin = toMin(cjs.realtimeDeparture || cjs.gbttBookedDeparture);
          if (depMin < arrMin + 1) continue;

          conns.push({
            status: statusFrom(cjs, imw),
            cljDep: cjs.gbttBookedDeparture || null,
            cljDepReal: cjs.realtimeDeparture || null,
            cljPlat: cjs.platform || null,
            imwArr: imw.gbttBookedArrival || null,
            imwArrReal: imw.realtimeArrival || null,
            imwPlat: imw.platform || null
          });
        }
      }catch(_e){}

      legs.push({
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        cljArr: cj.gbttBookedArrival || null,
        cljArrReal: cj.realtimeArrival || null,
        cljPlatArr: cj.platform || null,
        connections: conns
      });

      if (legs.length >= 3) break;
    }

    out.legs = legs;
  }catch(e){
    console.warn('First-leg fetch error:', String(e));
  }

  fs.writeFileSync('xfer.json', JSON.stringify(out,null,2));
  console.log('Wrote xfer.json (today-only, next three AFTER 07:25).');
})();
