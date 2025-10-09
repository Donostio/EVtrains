// scripts/xfer_plan.js
const fs = require("fs");

const USER = process.env.RTT_USERNAME;
const PASS = process.env.RTT_PASSWORD;
const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";

const ORG = "SRC";  // Streatham Common
const HUB = "CLJ";  // Clapham Junction
const DEST = "IMW"; // Imperial Wharf

const MIN_XFER_MIN = 1;
const MAX_SRC = 5;

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const H = { Authorization: auth, Accept: "application/json" };
const pad = n => String(n).padStart(2,'0');
const toM = t => parseInt(t.slice(0,2))*60 + parseInt(t.slice(2));
const diff = (a,b) => toM(a)-toM(b);

function parts(d=new Date()){
  return new Intl.DateTimeFormat("en-GB",{timeZone:LONDON_TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})
    .formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
}
function datePath(d=new Date()){ const p=parts(d); return `${p.year}/${p.month}/${p.day}`; }
async function j(u){ const r = await fetch(u,{headers:H}); if(!r.ok) throw new Error(`${r.status} ${r.statusText} ${u}`); return r.json(); }
const call = (crs, svc) => svc?.locations?.find(l=>l.crs===crs) || null;

async function search(origin, to, hhmm, dp){
  const url1 = `https://api.rtt.io/api/v1/json/search/${origin}/to/${to}/${dp}/${hhmm}`;
  try { return await j(url1); }
  catch { const url2=`https://api.rtt.io/api/v1/json/search/${origin}/${dp}/${hhmm}`; return await j(url2); }
}

(async()=>{
  try{
    if(!USER||!PASS) throw new Error("Missing RTT_USERNAME/RTT_PASSWORD");
    const now = new Date();
    const dp = datePath(now);
    const p = parts(now);
    const hhmm = p.hour + p.minute; // start “now”

    // 1) Next SRC->CLJ services
    const s1 = await search(ORG, HUB, hhmm, dp);
    const cand1 = (s1.services||[])
      .filter(s => s?.locationDetail?.gbttBookedDeparture)
      .sort((a,b)=> toM(a.locationDetail.gbttBookedDeparture)-toM(b.locationDetail.gbttBookedDeparture))
      .slice(0, 12);

    const options = [];

    for(const s of cand1){
      if(options.length >= MAX_SRC) break;
      const uid = s.serviceUid, runDate = s.runDate.replace(/-/g,"/");
      const det = await j(`https://api.rtt.io/api/v1/json/service/${uid}/${runDate}`);

      const o = call(ORG, det);      // SRC call
      const h = call(HUB, det);      // CLJ call
      if(!o || !h || o.isCancelled) continue;

      const srcDep = o.gbttBookedDeparture;
      const srcDepReal = o.realtimeDeparture || null;
      const cljArr = h.gbttBookedArrival || h.gbttBookedDeparture;
      const cljArrReal = h.realtimeArrival || h.realtimeDeparture || null;

      // 2) Find CLJ->IMW after cljArr + MIN_XFER_MIN
      const s2 = await search(HUB, DEST, cljArr || srcDep, dp);
      let chosen2 = null;
      for(const c2 of (s2.services||[]).slice(0,12)){
        const uid2 = c2.serviceUid, rd2 = c2.runDate.replace(/-/g,"/");
        const det2 = await j(`https://api.rtt.io/api/v1/json/service/${uid2}/${rd2}`);
        const c = call(HUB, det2), d = call(DEST, det2);
        if(!c || !d || c.isCancelled) continue;
        const depCLJ = c.gbttBookedDeparture || c.gbttBookedArrival;
        if(depCLJ && cljArr && diff(depCLJ, cljArr) >= MIN_XFER_MIN){ chosen2 = { c, d }; break; }
      }
      if(!chosen2) continue;

      // status heuristic
      let status = "on_time";
      if (o.isCancelled || h.isCancelled || chosen2.c.isCancelled || chosen2.d.isCancelled) status = "cancelled";
      else if ((o.realtimeDeparture && diff(o.realtimeDeparture, o.gbttBookedDeparture) > 0) ||
               (chosen2.d.realtimeArrival && diff(chosen2.d.realtimeArrival, chosen2.d.gbttBookedArrival) > 0)) status = "delayed";

      options.push({
        status,
        minTransfer: MIN_XFER_MIN,
        srcDep: srcDep,
        srcDepReal: srcDepReal || null,
        srcPlat: o.platform || null,
        cljArr: cljArr,
        cljArrReal: cljArrReal || null,
        cljDep: chosen2.c.gbttBookedDeparture || null,
        cljDepReal: chosen2.c.realtimeDeparture || null,
        cljPlat: chosen2.c.platform || null,
        imwArr: chosen2.d.gbttBookedArrival || null,
        imwArrReal: chosen2.d.realtimeArrival || null
      });
    }

    const payload = { generatedAt: new Date().toISOString(), options };
    fs.writeFileSync("xfer.json", JSON.stringify(payload, null, 2));
    console.log("Saved xfer.json with", options.length, "options");
  }catch(e){
    console.error(e);
    fs.writeFileSync("xfer.json", JSON.stringify({ error:String(e) }, null, 2));
  }
})();
