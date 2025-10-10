#!/usr/bin/env node
/**
 * xfer.json (ROLLED BACK):
 *  - Direct SRC->IMW 07:25  (uses **today** only)
 *  - Next three SRC->CLJ strictly after 07:25 up to 08:45 (uses **today** only)
 *  - Each with up to two CLJ->IMW connections departing >= 1 minute after CLJ arrival.
 *
 * No cutover to tomorrow. RID-first for detail to keep platforms/realtime.
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) { console.error('Missing RTT credentials'); process.exit(1); }

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const SRC='SRC', CLJ='CLJ', IMW='IMW';
const WINDOW_START = process.env.WINDOW_START || '0725';
const WINDOW_END   = process.env.WINDOW_END   || '0845';

// --- time/date helpers (TODAY ONLY) ---
function toMin(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2,4),10); }
function localYMD(tz){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return `${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`;
}
function todayISO(){ return localYMD(LONDON_TZ); }

// --- http helper ---
function fetchJSON(url){
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{Authorization:`Basic ${auth}`,'User-Agent':'rtt-gh-pages board'}},res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{
        if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }
      });
    }).on('error',reject);
  });
}

// --- logic helpers ---
function statusFrom(o,d){
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture!==o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival!==d.gbttBookedArrival;
  return (depLate||arrLate) ? 'delayed' : 'on_time';
}
const find = (detail, crs) => (detail?.locations||[]).find(l=>l.crs===crs) || {};

async function detailBySvc(svc, iso){
  if (svc.rid){
    try { return await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`); }
    catch(_e){}
  }
  const runISO = (svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate)) ? svc.runDate : iso;
  const mk = (u,d)=>`https://api.rtt.io/api/v1/json/service/${u}/${d}`;
  try{ return await fetchJSON(mk(svc.serviceUid, runISO)); }
  catch(e){
    if (!String(e).includes('HTTP 404')) throw e;
    // allow ±1 day in case RTT’s runDate nudges
    for (const dlt of [+1,-1]){
      try { return await fetchJSON(mk(svc.serviceUid, (new Date(runISO) && `${runISO}`.slice(0,10)).replace(/.*/,(x)=>x)/*.noop*/ ); }
      catch(_e){}
    }
    throw e;
  }
}

async function search(from,to,datePath,hhmm){
  const base=`https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url = hhmm?`${base}/${hhmm}`:base;
  const js = await fetchJSON(url);
  return js?.services||[];
}

(async ()=>{
  const iso = todayISO();                 // <-- ROLLBACK: always today
  const [y,m,d] = iso.split('-'); const datePath = `${y}/${m}/${d}`;
  console.log(`[xfer_plan] ROLLBACK mode, date=${iso}`);

  const out = { generatedAt:new Date().toISOString(), datePath, window:{start:WINDOW_START,end:WINDOW_END}, direct:null, legs:[] };

  // ---- Direct SRC -> IMW at 07:25 (today) ----
  try{
    const svcs = await search(SRC, IMW, datePath, WINDOW_START);
    const svc  = svcs.find(s => (s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture) === WINDOW_START) || svcs[0];
    if (svc){
      const det = await detailBySvc(svc, iso);
      const o = find(det,SRC), iw = find(det,IMW);
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

  // ---- First legs SRC -> CLJ strictly AFTER 07:25 (today) ----
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
      catch(e){ console.warn('First-leg detail 404, skipping:', String(e)); continue; }

      const o = find(det, SRC);
      const a = find(det, CLJ);
      if (!o?.gbttBookedDeparture || !a?.gbttBookedArrival) continue;

      // Connections: CLJ -> IMW, depart >= (arrReal||arrBooked) + 1 minute
      const arrMin = toMin(a.realtimeArrival || a.gbttBookedArrival);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns = [];
      try{
        const cand = await search(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length >= 2) break;
          if (!c?.serviceUid) continue;
          let cd; try { cd = await detailBySvc(c, iso); } catch(e){ continue; }
          const cj = find(cd, CLJ);
          const iw = find(cd, IMW);
          if (!cj?.gbttBookedDeparture || !iw?.gbttBookedArrival) continue;

          const depMin = toMin(cj.realtimeDeparture || cj.gbttBookedDeparture);
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
      }catch(_e){}

      legs.push({
        srcDep: o.gbttBookedDeparture || null,
        srcDepReal: o.realtimeDeparture || null,
        srcPlat: o.platform || null,
        cljArr: a.gbttBookedArrival || null,
        cljArrReal: a.realtimeArrival || null,
        cljPlatArr: a.platform || null,
        connections: conns
      });

      if (legs.length >= 3) break; // keep only next three AFTER 07:25
    }

    out.legs = legs;
  }catch(e){ console.warn('First-leg fetch error:', String(e)); }

  fs.writeFileSync('xfer.json', JSON.stringify(out,null,2));
  console.log('Wrote xfer.json (ROLLED BACK to today/after 07:25).');
})();
