#!/usr/bin/env node
const https = require('https');
const fs = require('fs');

const USER = process.env.RTT_USERNAME || '';
const PASS = process.env.RTT_PASSWORD || '';
if (!USER || !PASS) { console.error('Missing RTT credentials'); process.exit(0); }

const ORIGIN = process.env.ORIGIN_CRS || 'STE';
const DEST   = process.env.DEST_CRS   || 'WIM';
const HHMM   = process.env.BOOKED_DEPART_HHMM || '0744';
const LONDON_TZ = process.env.LONDON_TZ || 'Europe/London';
const CUTOVER   = process.env.CUTOVER_LOCAL_TIME || '09:00';

function toMinAny(h){ const s=(h||'').replace(':',''); return parseInt(s.slice(0,2)||'0',10)*60+parseInt(s.slice(2,4)||'0',10); }
function localYMD(tz){
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  return `${p.find(x=>x.type==='year').value}-${p.find(x=>x.type==='month').value}-${p.find(x=>x.type==='day').value}`;
}
function localHM(tz){ return new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()); }
function isoShiftDays(iso, days){ const d=new Date(iso+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
function targetISO(){ const today=localYMD(LONDON_TZ); const hm=localHM(LONDON_TZ); return toMinAny(hm)>=toMinAny(CUTOVER)?isoShiftDays(today,+1):today; }

function fetchJSON(url){
  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  return new Promise((resolve,reject)=>{
    https.get(url,{headers:{Authorization:`Basic ${auth}`,'User-Agent':'rtt-gh-pages board'}},res=>{
      let data=''; res.on('data',d=>data+=d);
      res.on('end',()=>{ if(res.statusCode<200||res.statusCode>=300) return reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage} for ${url}`));
        try{ resolve(JSON.parse(data)); }catch(e){ reject(e); }});
    }).on('error',reject);
  });
}

function toMin(hhmm){ return parseInt(hhmm.slice(0,2),10)*60 + parseInt(hhmm.slice(2,4),10); }
function statusFrom(o,d){
  if (o?.isCancelled||d?.isCancelled) return 'cancelled';
  const depLate = o?.gbttBookedDeparture && o?.realtimeDeparture && o.realtimeDeparture!==o.gbttBookedDeparture;
  const arrLate = d?.gbttBookedArrival && d?.realtimeArrival && d.realtimeArrival!==d.gbttBookedArrival;
  return (depLate||arrLate)?'delayed':'on_time';
}

(async ()=>{
  const iso = targetISO();
  const [y,m,d]=iso.split('-'); const datePath=`/${y}/${m}/${d}`;
  console.log(`[fetch_rtt] targetISO=${iso}`);

  // 1) SEARCH
  let search;
  try{
    search = await fetchJSON(`https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}${datePath}/${HHMM}`);
  }catch(e){
    console.warn('SEARCH failed:', String(e));
    return; // keep last good file
  }

  const svcs = search?.services||[];
  const svc  = svcs.find(s=>(s?.locationDetail?.gbttBookedDeparture||s?.gbttBookedDeparture)===HHMM) || svcs[0];
  if (!svc?.serviceUid){ console.warn('No service in search; leaving status.json unchanged'); return; }

  // 2) DETAIL by RID (preferred), else UID+date
  let detail=null;
  try{
    if (svc.rid){
      detail = await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.rid}`);
    }else{
      // rare, but fallback
      try{ detail = await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.serviceUid}/${iso}`); }
      catch(e){
        // try +/- 1 day just in case
        for (const dlt of [+1,-1]) {
          try { detail = await fetchJSON(`https://api.rtt.io/api/v1/json/service/${svc.serviceUid}/${isoShiftDays(iso,dlt)}`); break; }
          catch(_){}
        }
        if (!detail) throw e;
      }
    }
  }catch(e){
    console.warn('DETAIL failed:', String(e));
    return; // keep last good file
  }

  const find = crs => (detail?.locations||[]).find(l=>l.crs===crs) || {};
  const o=find(ORIGIN), dest=find(DEST);

  const out={
    generatedAt:new Date().toISOString(),
    date: svc.runDate || iso,
    originCRS: ORIGIN, destinationCRS: DEST,
    serviceUid: svc.serviceUid, rid: svc.rid||null,
    gbttBookedDeparture: HHMM,
    origin:{
      bookedArrival: o.gbttBookedArrival||null, bookedDeparture:o.gbttBookedDeparture||null,
      realtimeArrival:o.realtimeArrival||null, realtimeDeparture:o.realtimeDeparture||null,
      arrivalDelayMins: o.realtimeArrival&&o.gbttBookedArrival?toMin(o.realtimeArrival)-toMin(o.gbttBookedArrival):null,
      departureDelayMins:o.realtimeDeparture&&o.gbttBookedDeparture?toMin(o.realtimeDeparture)-toMin(o.gbttBookedDeparture):null,
      platform:o.platform||null, isCancelled:!!o.isCancelled
    },
    destination:{
      bookedArrival: dest.gbttBookedArrival||null, bookedDeparture:dest.gbttBookedDeparture||null,
      realtimeArrival:dest.realtimeArrival||null, realtimeDeparture:dest.realtimeDeparture||null,
      arrivalDelayMins: dest.realtimeArrival&&dest.gbttBookedArrival?toMin(dest.realtimeArrival)-toMin(dest.gbttBookedArrival):null,
      departureDelayMins:dest.realtimeDeparture&&dest.gbttBookedDeparture?toMin(dest.realtimeDeparture)-toMin(dest.gbttBookedDeparture):null,
      platform:dest.platform||null, isCancelled:!!dest.isCancelled
    },
    status: statusFrom(o,dest),
    searchUrl: `https://api.rtt.io/api/v1/json/search/${ORIGIN}/to/${DEST}${datePath}/${HHMM}`
  };

  // write safely (temp then replace)
  const tmp='status.tmp.json';
  fs.writeFileSync(tmp, JSON.stringify(out,null,2));
  fs.renameSync(tmp, 'status.json');
  console.log('Wrote status.json');
})();
