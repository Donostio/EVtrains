// scripts/xfer_plan.js
// Bottom-left tile data builder (xfer.json)
// - Direct: SRC->IMW at 07:25 (always shown first)
// - Legs: next 3 SRC->CLJ after max(07:25, now), up to 08:45,
//         each with up to 2 CLJ->IMW connections that depart >= 1 min after CLJ arrival.
// Includes realtime + platforms via Realtime Trains Pull API.

const fs = require("fs");

// Env
const USER = process.env.RTT_USERNAME;
const PASS = process.env.RTT_PASSWORD;
const LONDON_TZ = process.env.LONDON_TZ || "Europe/London";

// CRS
const SRC = "SRC";  // Streatham Common
const CLJ = "CLJ";  // Clapham Junction
const IMW = "IMW";  // Imperial Wharf

// Config
const DIRECT_DEP = "0725";     // fixed direct SRC->IMW booked dep
const WINDOW_END = "0845";     // cap legs and connections to 08:45
const MAX_LEGS = 3;
const MAX_CONN_PER_LEG = 2;
const MIN_XFER_MIN = 1;

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const H = { Authorization: auth, Accept: "application/json" };

const pad = n => String(n).padStart(2,'0');
const toM = t => parseInt(t.slice(0,2),10)*60 + parseInt(t.slice(2),10);
const diff = (a,b) => toM(a)-toM(b);

function parts(d=new Date()){
  return new Intl.DateTimeFormat("en-GB",{
    timeZone:LONDON_TZ, year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", hour12:false
  }).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
}

// Today until 17:00, then tomorrow (match your other tile)
function chooseDatePath(){
  const p = parts();
  let y=+p.year, m=+p.month, d=+p.day;
  if(+p.hour >= 17){
    const dt = new Date(Date.UTC(y,m-1,d,12,0,0));
    dt.setUTCDate(dt.getUTCDate()+1);
    const np = parts(dt);
    y=+np.year; m=+np.month; d=+np.day;
  }
  return `${y}/${pad(m)}/${pad(d)}`; // slashes for RTT
}

function nowHHMM(){
  const p = parts();
  return p.hour + p.minute; // "HHMM"
}

async function j(url){
  const r = await fetch(url, { headers: H });
  if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} ${url}`);
  return r.json();
}

const call = (crs, svc) => svc?.locations?.find(l=>l.crs===crs) || null;

function callInfo(c){
  if(!c) return null;
  const bookedArr = c.gbttBookedArrival || null;
  const bookedDep = c.gbttBookedDeparture || null;
  const rtArr = c.realtimeArrival || null;
  const rtDep = c.realtimeDeparture || null;
  const arrDelay = (rtArr && bookedArr) ? diff(rtArr, bookedArr) : null;
  const depDelay = (rtDep && bookedDep) ? diff(rtDep, bookedDep) : null;
  return {
    bookedArrival: bookedArr,
    bookedDeparture: bookedDep,
    realtimeArrival: rtArr,
    realtimeDeparture: rtDep,
    arrivalDelayMins: arrDelay,
    departureDelayMins: depDelay,
    platform: c.platform || null,
    isCancelled: !!c.isCancelled,
    cancelReasonShortText: c.cancelReasonShortText || null
  };
}

function statusFrom(legStart, legEnd){
  if(legStart?.isCancelled || legEnd?.isCancelled) return "cancelled";
  const late = (legStart?.departureDelayMins ?? 0) > 0 || (legEnd?.arrivalDelayMins ?? 0) > 0;
  const early = (legStart?.departureDelayMins ?? 0) < 0 || (legEnd?.arrivalDelayMins ?? 0) < 0;
  if(late) return "delayed";
  if(early) return "early";
  return "on_time";
}

// Search helpers (prefer filtered /to/ then fallback)
async function search(origin, to, hhmm, dp){
  const f = `https://api.rtt.io/api/v1/json/search/${origin}/to/${to}/${dp}/${hhmm}`;
  try { return await j(f); }
  catch {
    const u = `https://api.rtt.io/api/v1/json/search/${origin}/${dp}/${hhmm}`;
    return await j(u);
  }
}

(async()=>{
  try{
    if(!USER || !PASS) throw new Error("Missing RTT_USERNAME/RTT_PASSWORD");
    const datePath = chooseDatePath();

    // ---------- Direct SRC->IMW at 07:25 ----------
    let direct = null;
    try{
      const s = await search(SRC, IMW, DIRECT_DEP, datePath);
      const svc = (s.services||[]).find(x =>
        x?.locationDetail?.gbttBookedDeparture === DIRECT_DEP && x?.destination?.[0]?.crs === IMW
      ) || (s.services||[])[0];
      if(svc){
        const detail = await j(`https://api.rtt.io/api/v1/json/service/${svc.serviceUid}/${svc.runDate.replace(/-/g,"/")}`);
        const o = call(SRC, detail), d = call(IMW, detail);
        const oi = callInfo(o), di = callInfo(d);
        direct = {
          status: statusFrom(oi, di),
          srcDep: oi?.bookedDeparture || DIRECT_DEP,
          srcDepReal: oi?.realtimeDeparture || null,
          srcPlat: oi?.platform || null,
          imwArr: di?.bookedArrival || null,
          imwArrReal: di?.realtimeArrival || null,
          imwPlat: di?.platform || null
        };
      }
    }catch{/* ignore, leave null */}

    // ---------- Legs: next 3 SRC->CLJ after max(07:25, NOW), <= 08:45 ----------
    const start = (() => {
      const n = nowHHMM();
      return toM(n) > toM(DIRECT_DEP) ? n : DIRECT_DEP;
    })();

    const s1 = await search(SRC, CLJ, start, datePath);
    const allSrc = (s1.services||[])
      .filter(x => x?.locationDetail?.gbttBookedDeparture)
      .filter(x => x.locationDetail.gbttBookedDeparture > start && x.locationDetail.gbttBookedDeparture <= WINDOW_END)
      .sort((a,b) => toM(a.locationDetail.gbttBookedDeparture) - toM(b.locationDetail.gbttBookedDeparture));

    const legs = [];

    for(const svc of allSrc){
      if(legs.length >= MAX_LEGS) break;
      const uid = svc.serviceUid, rd = svc.runDate?.replace(/-/g,"/");
      if(!uid || !rd) continue;

      const det = await j(`https://api.rtt.io/api/v1/json/service/${uid}/${rd}`);
      const o = call(SRC, det), h = call(CLJ, det);
      if(!o || !h || o.isCancelled) continue;

      const oi = callInfo(o), hi = callInfo(h);
      const cljArrBooked = hi.bookedArrival || hi.bookedDeparture;
      if(!cljArrBooked) continue;

      // Connections: CLJ->IMW departing >= 1 min after CLJ arrival, <= WINDOW_END
      const s2 = await search(CLJ, IMW, cljArrBooked, datePath);
      const cand = (s2.services||[]);
      const conns = [];

      for(const s2c of cand){
        if(conns.length >= MAX_CONN_PER_LEG) break;
        const uid2 = s2c.serviceUid, rd2 = s2c.runDate?.replace(/-/g,"/");
        if(!uid2 || !rd2) continue;
        const ddet = await j(`https://api.rtt.io/api/v1/json/service/${uid2}/${rd2}`);
        const c = call(CLJ, ddet), d = call(IMW, ddet);
        if(!c || !d || c.isCancelled) continue;

        const ci = callInfo(c), di = callInfo(d);
        const depCLJ = ci.bookedDeparture || ci.bookedArrival;
        if(!depCLJ) continue;
        if(toM(depCLJ) <= toM(cljArrBooked)) continue;                      // must be after arrival
        if(diff(depCLJ, cljArrBooked) < MIN_XFER_MIN) continue;             // >= 1 minute
        if(toM(depCLJ) > toM(WINDOW_END)) continue;                         // within window

        conns.push({
          status: statusFrom(ci, di),
          cljDep: ci.bookedDeparture || null,
          cljDepReal: ci.realtimeDeparture || null,
          cljPlat: ci.platform || null,
          imwArr: di.bookedArrival || null,
          imwArrReal: di.realtimeArrival || null,
          imwPlat: di.platform || null
        });
      }

      legs.push({
        srcDep: oi.bookedDeparture,
        srcDepReal: oi.realtimeDeparture || null,
        srcPlat: oi.platform || null,
        cljArr: hi.bookedArrival || hi.bookedDeparture,
        cljArrReal: hi.realtimeArrival || hi.realtimeDeparture || null,
        cljPlatArr: hi.platform || null,
        connections: conns
      });
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      datePath,
      window: { start, end: WINDOW_END },
      direct,
      legs
    };

    fs.writeFileSync("xfer.json", JSON.stringify(payload, null, 2));
    console.log("Saved xfer.json:", { direct: !!direct, legs: legs.length, start, end: WINDOW_END });
  }catch(e){
    console.error(e);
    fs.writeFileSync("xfer.json", JSON.stringify({ error:String(e) }, null, 2));
  }
})();
