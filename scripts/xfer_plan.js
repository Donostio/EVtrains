#!/usr/bin/env node
/**
 * Build xfer.json:
 *  - TODAY only (Europe/London)
 *  - Direct SRC->IMW at 07:25
 *  - Next 3 SRC->CLJ strictly AFTER 07:25 and <= 08:45
 *  - For each first leg, up to 2 CLJ->IMW connections departing >= 1 min after CLJ arrival
 *  - RID-first for detail; fallback to service/{uid}/{runDate} with ±1 day
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) { console.error('Missing RTT credentials'); process.exit(1); }

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const SRC='SRC', CLJ='CLJ', IMW='IMW';

const WINDOW_START = process.env.WINDOW_START || '0725'; // anchor
const WINDOW_END   = process.env.WINDOW_END   || '0845'; // cut-off

/* ---------- time (today only) ---------- */
function localYMD(tz){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return `${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`;
}
function isoShiftDays(iso, days){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function toMin(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2,4),10); }

/* ---------- net ---------- */
function fetchJSON(url){
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{Authorization:`Basic ${auth}`,'User-Agent':'evtrains'}},res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }});
    }).on('error',reject);
  });
}

/* ---------- logic ---------- */
function statusFrom(o,d){
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture!==o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival!==d.gbttBookedArrival;
  return (depLate||arrLate) ? 'delayed' : 'on_time';
}
const stop = (detail, crs) => (detail?.locations||[]).find(l=>l.crs===crs) || {};

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
    for (const dlt of [+1,-1]){ try{ return await fetchJSON(mk(svc.serviceUid, isoShiftDays(runISO,dlt))); }catch(_e){} }
    throw e;
  }
}

async function search(from,to,datePath,hhmm){
  const base = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}/${datePath}`;
  const url  = hhmm ? `${base}/${hhmm}` : base;
  const js = await fetchJSON(url);
  return js?.services||[];
}

/* ---------- main ---------- */
(async ()=>{
  const iso = localYMD(LONDON_TZ);   // TODAY only
  const [y,m,d] = iso.split('-'); const datePath = `${y}/${m}/${d}`;
  console.log(`[xfer_plan] today=${iso} window=${WINDOW_START}-${WINDOW_END}`);

  const out = { generatedAt:new Date().toISOString(), datePath, window:{start:WINDOW_START,end:WINDOW_END}, direct:null, legs:[] };

  // --- Direct SRC -> IMW 07:25 ---
  try{
    const svcs = await search(SRC, IMW, datePath, WINDOW_START);
    const svc  = svcs.find(s => ((s?.locationDetail?.gbttBookedDeparture||s?.gbttBookedDeparture)===WINDOW_START) && s.rid)
              || svcs.find(s => s.rid)
              || svcs[0];
    if (svc){
      const det = await detailBySvc(svc, iso);
      const o=stop(det,SRC), iw=stop(det,IMW);
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

  // --- First legs: next 3 SRC -> CLJ strictly AFTER 07:25 and <= 08:45 ---
  try{
    const all = await search(SRC, CLJ, datePath, WINDOW_START);
    const after = all
      .filter(s=>{
        const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
        return dep && toMin(dep) > toMin(WINDOW_START) && toMin(dep) <= toMin(WINDOW_END);
      })
      .filter(s => !!s.rid); // prefer services we can detail by RID (stable later in day)

    const legs=[];
    for (const svc of after){
      if (legs.length >= 3) break;
      let det; try{ det = await detailBySvc(svc, iso); }catch(e){ console.warn('First-leg detail skip:', String(e)); continue; }
      const o=stop(det,SRC), cj=stop(det,CLJ);
      if (!o?.gbttBookedDeparture || !cj?.gbttBookedArrival) continue;

      // Connections: CLJ -> IMW depart >= (arrReal||arrBooked)+1 min
      const arrMin = toMin(cj.realtimeArrival || cj.gbttBookedArrival);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns=[];
      try{
        const cand = await search(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length >= 2) break;
          if (!c?.rid && !c?.serviceUid) continue;
          let cd; try{ cd = await detailBySvc(c, iso); }catch(_e){ continue; }
          const cjs=stop(cd,CLJ), imw=stop(cd,IMW);
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
    }

    out.legs = legs;
  }catch(e){ console.warn('First-leg fetch error:', String(e)); }

  fs.writeFileSync('xfer.json', JSON.stringify(out,null,2));
  console.log('Wrote xfer.json (today-only, next three AFTER 07:25).');
})();

