#!/usr/bin/env node
/**
 * xfer.json:
 *  - Direct SRC->IMW 07:25 (target date rolls after 09:00)
 *  - Next three SRC->CLJ strictly after 07:25 up to WINDOW_END,
 *    each with up to two CLJ->IMW connections departing >= 1 minute after CLJ arrival.
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) { console.error('Missing RTT credentials'); process.exit(1); }

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const CUTOVER   = process.env.CUTOVER_LOCAL_TIME || '09:00';

const SRC = 'SRC', CLJ='CLJ', IMW='IMW';
const WINDOW_START = process.env.WINDOW_START || '0725';
const WINDOW_END   = process.env.WINDOW_END   || '0845';

function toMinutes(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2),10); }
function localYMD(tz){
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const y=parts.find(p=>p.type==='year').value, m=parts.find(p=>p.type==='month').value, d=parts.find(p=>p.type==='day').value;
  return `${y}-${m}-${d}`;
}
function localHM(tz){ return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()); }
function isoShiftDays(iso, days){ const dt=new Date(iso+'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate()+days); return dt.toISOString().slice(0,10); }
function targetServiceDate(tz=LONDON_TZ, cut=CUTOVER){
  const today = localYMD(tz), hm=localHM(tz);
  return (toMinutes(hm)>=toMinutes(cut)) ? isoShiftDays(today,+1) : today;
}

function fetchJSON(url){
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    const req = https.get(url, { headers:{ Authorization:`Basic ${auth}`, 'User-Agent':'rtt-gh-pages board' }}, res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end', ()=>{
        if (res.statusCode<200 || res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
  });
}

function statusFrom(o,d){
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture!==o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival!==d.gbttBookedArrival;
  return (depLate||arrLate) ? 'delayed' : 'on_time';
}
function findStop(detail, crs){ return (detail?.locations||[]).find(l=>l.crs===crs) || {}; }

async function getDetailWithFallback(uid, primaryISO){
  const mk = (u,d)=>`https://api.rtt.io/api/v1/json/service/${u}/${d}`;
  try{ return await fetchJSON(mk(uid, primaryISO)); }
  catch(e){
    const msg = String(e);
    if (!msg.includes('HTTP 404')) throw e;
    for (const delta of [+1,-1]){
      try{ return await fetchJSON(mk(uid, isoShiftDays(primaryISO, delta))); }
      catch(_e){}
    }
    throw e;
  }
}

async function searchFromTo(from,to,datePath,hhmm){
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url = hhmm ? `${base}/${hhmm}` : base;
  const json = await fetchJSON(url);
  return json?.services || [];
}

(async ()=>{
  const iso = targetServiceDate();
  const [y,m,d] = iso.split('-'); const datePath = `${y}/${m}/${d}`;
  console.log(`[xfer_plan] tz=${LONDON_TZ} hm=${localHM(LONDON_TZ)} cut=${CUTOVER} targetISO=${iso}`);

  const out = { generatedAt:new Date().toISOString(), datePath, window:{start:WINDOW_START,end:WINDOW_END}, direct:null, legs:[] };

  // ---- Direct SRC -> IMW at 07:25 ----
  try{
    const directServices = await searchFromTo(SRC, IMW, datePath, WINDOW_START);
    let directSvc = directServices.find(s => (s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture)===WINDOW_START) || directServices[0];
    if (directSvc?.serviceUid){
      const runISO = (directSvc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(directSvc.runDate)) ? directSvc.runDate : iso;
      const detail = await getDetailWithFallback(directSvc.serviceUid, runISO);
      const o = findStop(detail, SRC), iw = findStop(detail, IMW);
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
  }catch(e){ console.warn('Direct fetch error:', String(e)); }

  // ---- First legs SRC -> CLJ strictly AFTER 07:25 ----
  try{
    const all = await searchFromTo(SRC, CLJ, datePath, WINDOW_START);
    const after = all.filter(s=>{
      const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
      return dep && toMinutes(dep)>toMinutes(WINDOW_START) && toMinutes(dep)<=toMinutes(WINDOW_END);
    });

    const legs=[];
    for (const svc of after){
      if (!svc?.serviceUid) continue;
      const runISO = (svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate)) ? svc.runDate : iso;
      let det;
      try { det = await getDetailWithFallback(svc.serviceUid, runISO); }
      catch(e){ console.warn('First-leg detail 404, skipping:', String(e)); continue; }

      const o = findStop(det, SRC);
      const a = findStop(det, CLJ);
      if (!o?.gbttBookedDeparture || !a?.gbttBookedArrival) continue;

      const arrMin = toMinutes(a.realtimeArrival || a.gbttBookedArrival);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns=[];
      try{
        const cand = await searchFromTo(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length>=2) break;
          if (!c?.serviceUid) continue;
          const run2 = (c.runDate && /^\d{4}-\d{2}-\d{2}$/.test(c.runDate)) ? c.runDate : iso;
          let cd;
          try { cd = await getDetailWithFallback(c.serviceUid, run2); }
          catch(e){ continue; }

          const cj = findStop(cd, CLJ), iw = findStop(cd, IMW);
          if (!cj?.gbttBookedDeparture || !iw?.gbttBookedArrival) continue;

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
      }catch(e){ /* swallow */ }

      legs.push({
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        cljArr: a.gbttBookedArrival || null,
        cljArrReal: a.realtimeArrival || null,
        cljPlatArr: a.platform || null,
        connections: conns
      });

      if (legs.length>=3) break;
    }
    out.legs = legs;
  }catch(e){ console.warn('First-leg fetch error:', String(e)); }

  fs.writeFileSync('xfer.json', JSON.stringify(out,null,2));
  console.log('Wrote xfer.json for target date', iso);
})();
