#!/usr/bin/env node
/**
 * xfer.json:
 *  - Direct SRC->IMW 07:25 (target date rolls after 09:00)
 *  - Next three SRC->CLJ strictly after a dynamic baseline:
 *      * before 07:25 today  -> baseline = 07:25
 *      * 07:25..08:45 today  -> baseline = current time
 *      * after 09:00 (rolls) -> baseline = 07:25 (tomorrow)
 *    Each with up to two CLJ->IMW connections departing >= 1 minute after CLJ arrival.
 *
 * Safe write (temp -> final) and RID-first detail to avoid UID+date 404s.
 */

const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) { console.error('Missing RTT credentials'); process.exit(0); }

const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const CUTOVER   = process.env.CUTOVER_LOCAL_TIME || '09:00';

const SRC='SRC', CLJ='CLJ', IMW='IMW';
const WINDOW_START = process.env.WINDOW_START || '0725';
const WINDOW_END   = process.env.WINDOW_END   || '0845';

// --- time/date helpers ---
function toMin(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2,4),10); }
function toMinAny(h){ const s=(h||'').replace(':',''); return parseInt(s.slice(0,2)||'0',10)*60 + parseInt(s.slice(2,4)||'0',10); }
function localYMD(tz){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return `${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`;
}
function localHM(tz){ return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()); }
function isoShiftDays(iso, days){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function targetISO(){
  const today=localYMD(LONDON_TZ); const hm=localHM(LONDON_TZ);
  return toMinAny(hm) >= toMinAny(CUTOVER) ? isoShiftDays(today,+1) : today;
}

// --- HTTP helper ---
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

// --- helpers ---
function statusFrom(o,d){
  if (o?.isCancelled || d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture!==o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival!==d.gbttBookedArrival;
  return (depLate||arrLate) ? 'delayed' : 'on_time';
}
const find = (detail, crs) => (detail?.locations||[]).find(l=>l.crs===crs) || {};

// Prefer detail by RID (no date); fall back to UID+date with ±1 day retry
async function detailBySvc(svc, fallbackISO){
  if (svc.rid){
    try { return await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`); }
    catch(_e){}
  }
  const runISO = (svc.runDate && /^\d{4}-\d{2}-\d{2}$/.test(svc.runDate)) ? svc.runDate : fallbackISO;
  const mk = (u,d)=>`https://api.rtt.io/api/v1/json/service/${u}/${d}`;
  try{ return await fetchJSON(mk(svc.serviceUid, runISO)); }
  catch(e){
    if (!String(e).includes('HTTP 404')) throw e;
    for (const dlt of [+1,-1]){
      try { return await fetchJSON(mk(svc.serviceUid, isoShiftDays(runISO,dlt))); } catch(_){}
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
  const iso = targetISO();
  const todayLocal = localYMD(LONDON_TZ);
  const [y,m,d]=iso.split('-');
  const datePath=`/${y}/${m}/${d}`;
  console.log(`[xfer_plan] targetISO=${iso} (todayLocal=${todayLocal})`);

  const out = { generatedAt:new Date().toISOString(), datePath:`${y}/${m}/${d}`, window:{start:WINDOW_START,end:WINDOW_END}, direct:null, legs:[] };

  // ---- Direct SRC->IMW 07:25 ----
  try{
    const svcs = await search(SRC, IMW, datePath, WINDOW_START);
    const svc  = svcs.find(s=>(s?.locationDetail?.gbttBookedDeparture||s?.gbttBookedDeparture)===WINDOW_START) || svcs[0];
    if (svc){
      const det = await detailBySvc(svc, iso);
      const o=find(det,SRC), iw=find(det,IMW);
      out.direct = {
        status: statusFrom(o,iw),
        srcDep:o.gbttBookedDeparture||null, srcDepReal:o.realtimeDeparture||null, srcPlat:o.platform||null,
        imwArr:iw.gbttBookedArrival||null, imwArrReal:iw.realtimeArrival||null, imwPlat:iw.platform||null
      };
    }
  }catch(e){ console.warn('Direct section failed:', String(e)); /* keep going */ }

  // ---- First legs SRC->CLJ (dynamic baseline) ----
  try{
    const all = await search(SRC, CLJ, datePath, WINDOW_START);

    // Decide baseline:
    // - If we're building for tomorrow (after 09:00), baseline is WINDOW_START (07:25).
    // - Else (today): if now is in (07:25..08:45), baseline is now; otherwise it's 07:25.
    let refStart = WINDOW_START;
    if (iso === todayLocal) {
      const nowHM = localHM(LONDON_TZ).replace(':','');
      const nowM  = toMin(nowHM);
      if (nowM > toMin(WINDOW_START) && nowM < toMin(WINDOW_END)) {
        refStart = nowHM;
      }
    }

    const after = all.filter(s=>{
      const dep = s?.locationDetail?.gbttBookedDeparture || s?.gbttBookedDeparture;
      return dep && toMin(dep) > toMin(refStart) && toMin(dep) <= toMin(WINDOW_END);
    });

    const legs=[];
    for (const svc of after){
      if (!svc?.serviceUid) continue;

      let det;
      try { det = await detailBySvc(svc, iso); }
      catch(e){ console.warn('First-leg detail skipped:', String(e)); continue; }

      const o=find(det,SRC);
      const a=find(det,CLJ);
      if (!o?.gbttBookedDeparture || !a?.gbttBookedArrival) continue;

      const arrMin = toMin(a.realtimeArrival || a.gbttBookedArrival);
      const startHHMM = String(Math.floor((arrMin+1)/60)).padStart(2,'0') + String((arrMin+1)%60).padStart(2,'0');

      const conns=[];
      try{
        const cand = await search(CLJ, IMW, datePath, startHHMM);
        for (const c of cand){
          if (conns.length>=2) break;
          let cd; try{ cd=await detailBySvc(c, iso); }catch(e){ continue; }
          const cj=find(cd,CLJ), iw=find(cd,IMW);
          if (!cj?.gbttBookedDeparture || !iw?.gbttBookedArrival) continue;

          const depMin = toMin(cj.realtimeDeparture || cj.gbttBookedDeparture);
          if (depMin < arrMin + 1) continue;

          conns.push({
            status: statusFrom(cj,iw),
            cljDep:cj.gbttBookedDeparture||null, cljDepReal:cj.realtimeDeparture||null, cljPlat:cj.platform||null,
            imwArr:iw.gbttBookedArrival||null,   imwArrReal:iw.realtimeArrival||null,   imwPlat:iw.platform||null
          });
        }
      }catch(_e){ /* ignore connection search errors */ }

      legs.push({
        srcDep:o.gbttBookedDeparture||null, srcDepReal:o.realtimeDeparture||null, srcPlat:o.platform||null,
        cljArr:a.gbttBookedArrival||null,   cljArrReal:a.realtimeArrival||null,   cljPlatArr:a.platform||null,
        connections: conns
      });

      if (legs.length>=3) break;
    }
    out.legs = legs;
  }catch(e){ console.warn('First-leg section failed:', String(e)); }

  // Safe write
  const tmp='xfer.tmp.json';
  fs.writeFileSync(tmp, JSON.stringify(out,null,2));
  fs.renameSync(tmp, 'xfer.json');
  console.log('Wrote xfer.json (baseline applied dynamically)');
})();
