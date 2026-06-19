//script
const proxyBaseUrl = "https://atrealtime.vercel.app";
const realtimeUrl  = `${proxyBaseUrl}/api/realtime`;
const routesUrl    = `${proxyBaseUrl}/api/routes`;
const tripsUrl     = `${proxyBaseUrl}/api/trips`;
const shapesUrl    = `${proxyBaseUrl}/api/shapes`;
const tripUpdatesUrl = `${proxyBaseUrl}/api/tripupdates`; // fallback only; see fetchVehicles
const busTypesUrl  = "busTypes.json";

const light = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",{attribution:"© OpenStreetMap contributors © CARTO",subdomains:"abcd",maxZoom:20});
const dark  = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{attribution:"© OpenStreetMap contributors © CARTO",subdomains:"abcd",maxZoom:20});
const osm   = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap contributors"});
const satellite  = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Tiles © Esri"});
const esriImagery= L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Tiles © Esri, Maxar, Earthstar Geographics",maxZoom:20});
const esriLabels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{attribution:"Labels © Esri",maxZoom:20});
const esriHybrid = L.layerGroup([esriImagery, esriLabels]);

const vehicleRenderer = L.canvas({padding:0.5});
const map = L.map("map",{center:[-36.8485,174.7633],zoom:12,layers:[light],zoomControl:false,preferCanvas:true,renderer:vehicleRenderer});
// Force the vehicle canvas to clear and repaint the WHOLE canvas on every redraw instead of
// just the changed markers' rectangles. Labels are wider than their dots, so partial-rect
// redraws left them half-erased by neighbours and made them vanish during tween/zoom. Full
// redraws cannot ghost or partially-erase; off-screen markers still self-cull in their draw.
vehicleRenderer._extendRedrawBounds = function(){};
const baseMaps = {"Light":light,"Dark":dark,"OSM":osm,"Satellite":satellite,"Esri Hybrid":esriHybrid};
L.control.layers(baseMaps,null).addTo(map);

const vehicleLayers={bus:L.layerGroup().addTo(map),train:L.layerGroup().addTo(map),ferry:L.layerGroup().addTo(map),out:L.layerGroup().addTo(map)};

const vehicleMarkers={};              
const tripCache={};                   
let routes={}, busTypes={}, busTypeIndex={};
const vehicleIndexByFleet=new Map();  
const routeIndex=new Map();         
const oosIndexByFleet=new Map();
const markersByTrip=new Map();        // tripId -> [markers], rebuilt each poll for O(1) trip lookups
const debugBox=document.getElementById("debug");
const mobileUpdateEl=document.getElementById("mobile-last-update");

let pinnedPopup=null;           
let pinnedFollow=false;            

map.on("click",()=>{
  if(pinnedPopup){ pinnedPopup.closePopup(); pinnedPopup=null; pinnedFollow=false; }
  clearRouteHighlights();
  clearRouteOutline();
});


map.on("dragstart", ()=> { pinnedFollow=false; });
map.on("popupclose", ()=> { pinnedFollow=false; });

const vehicleColors={bus:"#4a90e2",train:"#d0021b",ferry:"#1abc9c",out:"#9b9b9b"};
const trainLineColors={STH:"#d0021b",WEST:"#7fbf6a",EAST:"#f8e71c",ONE:"#0e76a8",HUIA:"#8e44ad"};
const occupancyLabels=["Empty","Many seats available","Few seats available","Standing only","Limited standing","Full","Not accepting passengers"];

// At/above this zoom, bus + train markers render as a labelled pill showing the route code
// (e.g. "STH", "70"); below it they stay as plain dots. Kept at suburb level so the full-city
// view stays light and pannable. Raise for fewer labels, lower (to 12) for the whole-region
// view, but expect heavier rendering when hundreds are on screen at once.
const LABEL_MIN_ZOOM=13;


const MIN_POLL_MS=15000, MAX_POLL_MS=27000;
function basePollDelay(){return MIN_POLL_MS+Math.floor(Math.random()*(MAX_POLL_MS-MIN_POLL_MS+1));}


const BACKOFF_START_MS=15000, BACKOFF_MAX_MS=120000;
const backoff = {
  realtime: { ms:0, until:0 },
  routes:   { ms:0, until:0 },
  trips:    { ms:0, until:0 },
  shapes:   { ms:0, until:0 },
  tripupdates: { ms:0, until:0 },
};
function applyRateLimitBackoff(retryAfterMs, who){
  const b = backoff[who] || backoff.realtime;
  let retry = retryAfterMs ? Math.max(0, retryAfterMs)
                           : (b.ms ? Math.min(BACKOFF_MAX_MS, b.ms*2) : BACKOFF_START_MS);
  if (who === "realtime") retry = Math.min(retry, 15000);
  b.ms = retry; b.until = Date.now()+retry;
  setDebug(`Rate limited by ${who}. Backing off ${Math.round(retry/1000)} s`);
}

let vehiclesAbort, vehiclesInFlight=false, pollTimeoutId=null, pageVisible=!document.hidden;
let hidePauseTimerId=null; const HIDE_PAUSE_DELAY_MS=10000;


function setDebug(msg){ if(debugBox) debugBox.textContent=msg; }
function setLastUpdateTs(ts){
  if (!mobileUpdateEl) return;
  const t = new Date(ts);
  const hh = String(t.getHours()).padStart(2,"0");
  const mm = String(t.getMinutes()).padStart(2,"0");
  const ss = String(t.getSeconds()).padStart(2,"0");
  mobileUpdateEl.textContent = `Last update: ${hh}:${mm}:${ss}`;
}

// Persist the fleet snapshot at most every 45s, on the idle queue, so a full-fleet
// JSON.stringify never blocks the frame on a poll. The cache only needs to be "recent
// enough" to seed a cold load, not perfectly current.
let lastSnapSaveTs=0;
function saveSnapshot(state){
  const now=Date.now();
  if(now-lastSnapSaveTs < 45000) return;
  lastSnapSaveTs=now;
  const write=()=>{ try{ localStorage.setItem("realtimeSnapshot",JSON.stringify(state)); }catch{} };
  if(window.requestIdleCallback) requestIdleCallback(write,{timeout:3000}); else setTimeout(write,0);
}

// ===================== IndexedDB cache (routes / trips / shapes) =====================
// Persists reference data across sessions so cold loads skip /api/routes entirely (when
// fresh) and avoid re-fetching trips/shapes already seen. This DIRECTLY reduces AT API
// calls, not just CPU. Every operation is defensive: any failure falls back to network.
// Keys: "routes" (single blob), "trip:<id>", "shape:<id>". Records are {t:savedMs, data}.
const IDB_NAME="atrt-cache", IDB_STORE="kv", IDB_VER=1;
const TTL_ROUTES = 24*3600*1000;   // routes change rarely
const TTL_TRIP   = 18*3600*1000;   // trip_ids are roughly service-day scoped
const TTL_SHAPE  = 7*24*3600*1000; // geometry is effectively static
let _idbPromise=null;
function idbOpen(){
  if(_idbPromise) return _idbPromise;
  _idbPromise=new Promise(resolve=>{
    let req;
    try{ req=indexedDB.open(IDB_NAME,IDB_VER); }catch{ resolve(null); return; }
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>resolve(null);
    req.onblocked=()=>resolve(null);
  }).catch(()=>null);
  return _idbPromise;
}
async function idbGet(key){
  const db=await idbOpen(); if(!db) return null;
  return new Promise(res=>{ try{ const r=db.transaction(IDB_STORE,"readonly").objectStore(IDB_STORE).get(key); r.onsuccess=()=>res(r.result??null); r.onerror=()=>res(null); }catch{ res(null); } });
}
// Batched put: one transaction for many [key,record] pairs.
async function idbPutMany(pairs){
  if(!pairs||!pairs.length) return;
  const db=await idbOpen(); if(!db) return;
  return new Promise(res=>{ try{ const tx=db.transaction(IDB_STORE,"readwrite"); const st=tx.objectStore(IDB_STORE); for(const [k,v] of pairs) st.put(v,k); tx.oncomplete=()=>res(); tx.onerror=()=>res(); tx.onabort=()=>res(); }catch{ res(); } });
}
// Iterate every record once: hydrate live caches and prune anything past its TTL.
async function idbHydrateAndPrune(){
  const db=await idbOpen(); if(!db) return;
  const now=Date.now();
  return new Promise(res=>{
    let cur;
    try{ cur=db.transaction(IDB_STORE,"readwrite").objectStore(IDB_STORE).openCursor(); }
    catch{ res(); return; }
    cur.onerror=()=>res();
    cur.onsuccess=e=>{
      const c=e.target.result;
      if(!c){ res(); return; }
      const key=c.key, rec=c.value;
      let ttl=0;
      if(typeof key==="string"){
        if(key.startsWith("trip:")) ttl=TTL_TRIP;
        else if(key.startsWith("shape:")) ttl=TTL_SHAPE;
      }
      if(rec && ttl && (now-(rec.t||0))<ttl){
        if(key.startsWith("trip:") && rec.data) tripCache[rec.data.trip_id]=rec.data;
        else if(key.startsWith("shape:") && rec.data) shapeCache.set(key.slice(6), rec.data);
      }else if(ttl){
        try{ c.delete(); }catch{}
      }
      c.continue();
    };
  });
}
function idbPutTrips(trips){
  if(!trips||!trips.length) return;
  const t=Date.now();
  idbPutMany(trips.map(tr=>[`trip:${tr.trip_id}`,{t,data:tr}]));
}
function idbPutShape(id, data){
  if(!id || !data) return; // never persist null ("tried, none") so it can retry next session
  idbPutMany([[`shape:${id}`,{t:Date.now(),data}]]);
}

function parseRetryAfterMs(v){ if(!v) return 0; const s=Number(v); if(!isNaN(s)) return Math.max(0,Math.floor(s*1000)); const t=Date.parse(v); return isNaN(t)?0:Math.max(0,t-Date.now()); }async function safeFetch(url,opts={}){
  try{
    const res=await fetch(url,{cache:"no-store",...opts});
    if(res.status===429){const retryAfterMs=parseRetryAfterMs(res.headers.get("Retry-After")); return {_rateLimited:true,retryAfterMs};}
    if(!res.ok){let body=""; try{body=await res.text();}catch{} throw new Error(`${res.status} ${res.statusText}${body?` | ${body.slice(0,200)}`:""}`);}
    return await res.json();
  }catch(err){console.error("Fetch error:",err); setDebug(`Fetch error: ${err.message}`); return null;}
}
function chunk(a,n){const o=[]; for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n)); return o;}
function buildBusTypeIndex(json){const idx={}; if(!json||typeof json!=="object") return idx; for(const model of Object.keys(json)){const ops=json[model]||{}; for(const op of Object.keys(ops)){const nums=ops[op]||[]; if(!idx[op]) idx[op]={}; for(const n of nums) idx[op][n]=model;}} return idx;}
function getBusType(op,num){const ix=busTypeIndex[op]; return ix?(ix[num]||""):"";}
function trainColorForRoute(s){ if(!s) return vehicleColors.train; if(s.includes("STH"))return trainLineColors.STH; if(s.includes("WEST"))return trainLineColors.WEST; if(s.includes("EAST"))return trainLineColors.EAST; if(s.includes("ONE"))return trainLineColors.ONE; return vehicleColors.train; }

// ---- Optional GTFS-RT field helpers -------------------------------------
// AT's docs claim odometer/bearing are often absent; these are emitted
// inconsistently per vehicle/mode, so every field below is rendered only
// when present and valid.
const COMPASS_16=["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const congestionLabels=["Unknown","Running smoothly","Stop and go","Congested","Severe congestion"];
const currentStatusLabels={0:"Approaching",1:"Stopped at",2:"In transit to"};

function toNum(v){ if(v===undefined||v===null||v==="") return null; const n=Number(v); return isFinite(n)?n:null; }

function bearingToCompass(deg){
  const d=toNum(deg); if(d===null) return "";
  const a=((d%360)+360)%360;
  return COMPASS_16[Math.round(a/22.5)%16];
}

function formatOdometer(meters){
  const m=toNum(meters); if(m===null||m<=0) return "";
  const km=m/1000;
  return `${km.toLocaleString(undefined,{maximumFractionDigits:km>=100?0:1})} km`;
}

function formatDataAge(tsSec){
  const t=toNum(tsSec); if(t===null||t<=0) return "";
  let ageMs=Date.now()-t*1000;
  if(ageMs<0) ageMs=0;
  const s=Math.round(ageMs/1000);
  if(s<60) return `${s}s ago`;
  const m=Math.floor(s/60), r=s%60;
  if(m<60) return r?`${m}m ${r}s ago`:`${m}m ago`;
  const h=Math.floor(m/60), rm=m%60;
  return rm?`${h}h ${rm}m ago`:`${h}h ago`;
}

// Builds the HTML for any optional fields that are actually present.
function buildExtraLines(ex){
  if(!ex) return "";
  const lines=[];
  if(ex.heading){
    const degTxt=(ex.bearingDeg!=null)?` (${Math.round(ex.bearingDeg)}°)`:"";
    lines.push(`<b>Heading:</b> ${ex.heading}${degTxt}`);
  }
  if(ex.odometer)  lines.push(`<b>Odometer:</b> ${ex.odometer}`);
  if(ex.statusLine)lines.push(`<b>Status:</b> ${ex.statusLine}`);
  if(ex.congestion)lines.push(`<b>Congestion:</b> ${ex.congestion}`);
  if(ex.tripStart) lines.push(`<b>Trip start:</b> ${ex.tripStart}`);
  if(ex.fixAge)    lines.push(`<b>Position fix:</b> ${ex.fixAge}`);
  return lines.length?("<br>"+lines.join("<br>")):"";
}

function buildPopup(routeName,destination,vehicleLabel,busType,licensePlate,speedStr,scheduleLine,occupancy,bikesLine,extraLines){
  return `<div style="font-size:0.9em;line-height:1.3;">
      <b>Route:</b> ${routeName}<br>
      <b>Destination:</b> ${destination}<br>
      <b>Vehicle:</b> ${vehicleLabel}<br>
      ${busType?`<b>Bus model:</b> ${busType}<br>`:""}
      <b>Number plate:</b> ${licensePlate}<br>
      <b>Speed:</b> ${speedStr}${scheduleLine||""}<br>
      <b>Occupancy:</b> ${occupancy}
      ${bikesLine||""}
      ${extraLines||""}
    </div>`;
}

// ---- Schedule adherence (late / early) from GTFS-RT trip updates --------------------
// Delay lives in trip_update entities, not in vehicle positions. AT's legacy feed is a
// combined feed, so these usually arrive in the SAME response we already fetch (no extra
// calls). buildDelayMap indexes them by trip_id; delayForTrip picks the most relevant
// stop's delay; formatDelay renders a coloured "X late / early / On time" line.
function buildDelayMap(entities){
  const map=new Map();
  for(const e of (entities||[])){
    const tu=e.trip_update||e.tripUpdate; if(!tu) continue;
    const tid=tu.trip?.trip_id ?? tu.trip?.tripId;
    if(tid) map.set(tid, tu);
  }
  return map;
}
function delayForTrip(tu, currentStopSeq){
  if(!tu) return null;
  const stus=tu.stop_time_update||tu.stopTimeUpdate||[];
  let chosen=null;
  if(currentStopSeq!=null && stus.length){
    let best=null;
    for(const s of stus){
      const seq=toNum(s.stop_sequence ?? s.stopSequence); if(seq==null) continue;
      if(seq>=currentStopSeq && (best==null || seq<best.seq)) best={seq,s};
    }
    chosen=best?.s || null;
  }
  if(!chosen && stus.length) chosen=stus[stus.length-1];
  let delay=null;
  if(chosen){
    const arr=chosen.arrival, dep=chosen.departure;
    delay = toNum(arr?.delay); if(delay==null) delay=toNum(dep?.delay);
  }
  if(delay==null) delay=toNum(tu.delay); // some feeds carry a trip-level delay
  return delay;
}
function formatDelay(sec){
  if(sec==null) return "";
  const a=Math.abs(Math.round(sec));
  if(a<=30) return "On time";
  const m=Math.floor(a/60), s=a%60;
  const t = a<60 ? `${a}s` : (s?`${m}m ${s}s`:`${m}m`);
  return sec>0 ? `${t} late` : `${t} early`;
}
function scheduleLineHtml(sec){
  if(sec==null) return "";
  const txt=formatDelay(sec);
  const col = txt==="On time" ? "#1a8f3c" : (sec>0 ? "#d0021b" : "#0a84ff");
  return `<br><b>Schedule:</b> <span style="color:${col}">${txt}</span>`;
}

// Fallback path: only used if the combined realtime feed carries no trip updates.
let useSeparateTripUpdates=false;
async function fetchTripUpdatesDelays(){
  const json=await safeFetch(tripUpdatesUrl);
  if(!json || json._rateLimited){ if(json&&json._rateLimited) applyRateLimitBackoff(json.retryAfterMs,"tripupdates"); return null; }
  const ents=json?.response?.entity||json?.entity||[];
  return buildDelayMap(ents);
}

// ===================== Motion / speed estimation =====================================
// Speed only. AT's position.speed is often missing, zeroed-while-moving, or stale, so we
// derive ground speed from successive GTFS-RT fixes (great-circle distance / Δt using each
// vehicle's own timestamp), smooth it with an EMA, and fall back to the feed value only
// when a fix-to-fix value cannot be computed (e.g. first sighting). Markers are placed at
// the reported feed positions on every poll; there is no between-poll projection.
const R_EARTH = 6371000;

const motionState = new Map(); // vehicleId -> motion record (persists across polls)

// Tuning knobs
const SPEED_EMA_ALPHA      = 0.4;    // displayed-speed smoothing (0..1, higher = snappier)
const DERIVE_MIN_DT_MS     = 2000;   // ignore fix gaps shorter than this (too noisy)
const DERIVE_MAX_DT_MS     = 90000;  // gaps longer than this => treat as a fresh anchor
const DERIVE_MAX_SPEED_MS  = 70;     // ~252 km/h; reject GPS glitches above this
const DR_MIN_BEARING_DISP_M= 5;      // need >5 m of travel to trust a derived bearing

// Shape fetching (used for the selected vehicle's route outline only).
const SHAPE_FETCH_CAP      = 18;     // max NEW shapes fetched per pass (keeps calls low)
const MIN_SHAPE_ZOOM       = 12;     // don't fetch shapes when zoomed too far out

const shapeCache    = new Map(); // shapeId -> {pts:[[lat,lon],...], cum:[m...], total} | null
const shapePending  = new Set(); // shapeIds currently being fetched

function toRad(d){ return d*Math.PI/180; }
function toDeg(r){ return r*180/Math.PI; }

// Great-circle distance (m).
function haversineM(lat1,lon1,lat2,lon2){
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R_EARTH*Math.asin(Math.min(1,Math.sqrt(a)));
}
// Initial bearing (deg, 0=N clockwise).
function bearingDegBetween(lat1,lon1,lat2,lon2){
  const p1=toRad(lat1), p2=toRad(lat2), dl=toRad(lon2-lon1);
  const y=Math.sin(dl)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (toDeg(Math.atan2(y,x))+360)%360;
}

// Build the cumulative-distance table for a raw [[lat,lon],...] shape.
function ingestShape(id, pts){
  if(!Array.isArray(pts) || pts.length<2){ shapeCache.set(id,null); return; }
  const cum=[0]; let total=0;
  for(let i=1;i<pts.length;i++){
    total+=haversineM(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]);
    cum.push(total);
  }
  const obj={pts,cum,total};
  shapeCache.set(id,obj);
  idbPutShape(id,obj); // survive reloads so revisited areas don't refetch /api/shapes
}

// Update a vehicle's motion record each poll and return display values.
//  fixTsMs: per-vehicle GTFS-RT timestamp in ms (0 if absent -> client time used).
//  feedSpeedMs / feedBearingDeg: normalised feed values, may be null.
// Returns {speedMs, bearingDeg, source} where source is "computed" | "GPS" | "".
function updateMotion(id,lat,lon,fixTsMs,feedSpeedMs,feedBearingDeg){
  const nowClient=Date.now();
  const prev=motionState.get(id);
  const effFixTs=fixTsMs||nowClient;
  const staleFix=!!(prev && fixTsMs && prev.fixTs===fixTsMs); // feed gave no new fix

  let derivedMs=null, derivedBearing=null;
  if(prev && !staleFix){
    const dt=effFixTs-prev.fixTs;
    if(dt>=DERIVE_MIN_DT_MS && dt<=DERIVE_MAX_DT_MS){
      const dist=haversineM(prev.fixLat,prev.fixLon,lat,lon);
      const v=dist/(dt/1000);
      if(v<=DERIVE_MAX_SPEED_MS){
        derivedMs=v;
        if(dist>=DR_MIN_BEARING_DISP_M) derivedBearing=bearingDegBetween(prev.fixLat,prev.fixLon,lat,lon);
      }
    }
  }

  // Prefer the fix-to-fix value (consistent, immune to feed quirks); feed is fallback.
  let rawMs=null, source="";
  if(derivedMs!=null){ rawMs=derivedMs; source="computed"; }
  else if(feedSpeedMs!=null){ rawMs=feedSpeedMs; source="GPS"; }

  // EMA-smooth the displayed speed; keep last value if nothing new this poll.
  let speedMs=rawMs;
  if(rawMs!=null){
    speedMs=(prev && prev.speedMs!=null) ? prev.speedMs+SPEED_EMA_ALPHA*(rawMs-prev.speedMs) : rawMs;
  }else if(prev){
    speedMs=prev.speedMs; source=prev.source;
  }

  // Bearing for heading display: derived -> feed -> previous.
  let bearingDeg=null;
  if(derivedBearing!=null) bearingDeg=derivedBearing;
  else if(feedBearingDeg!=null) bearingDeg=((feedBearingDeg%360)+360)%360;
  else if(prev && prev.bearingDeg!=null) bearingDeg=prev.bearingDeg;

  motionState.set(id,{
    fixLat:lat, fixLon:lon, fixTs:effFixTs,
    speedMs, bearingDeg, source
  });

  return {speedMs, bearingDeg, source};
}

// Keep the followed vehicle roughly centred. Called once per poll after positions update,
// and per-frame while a tween is running so following stays smooth.
function followPinnedIfNeeded(animate){
  if(!(pinnedPopup && pinnedFollow)) return;
  try{
    const ll=pinnedPopup.getLatLng();
    const c=map.latLngToLayerPoint(map.getCenter());
    const p=map.latLngToLayerPoint(ll);
    if(Math.abs(c.x-p.x)>6 || Math.abs(c.y-p.y)>6) map.panTo(ll,{animate});
  }catch{}
}

// ===================== Position tween (between consecutive reported fixes) ============
// On each position update, glides the marker once from its old fix to the new fix over
// POS_TWEEN_MS, then leaves it static until the next update. This interpolates ONLY between
// two known truths: it never advances a marker past the latest fix, so it cannot invent
// position the way dead reckoning did. The loop is self-stopping (no rAF when idle/hidden)
// and skips work with no visual benefit (hidden tab, reduced-motion, off-screen, big jumps).
const TWEEN_SNAP_M = 1000;  // jumps larger than this snap instantly (glitch / reappearance)
const POS_TWEEN_MS = 650;   // one-shot glide into each new reported fix, then the marker is static
const prefersReducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

const activeTweens = new Map(); // vehicleId -> {sLat,sLon,eLat,eLon,start}
let tweenRafId = null;

// Queue a marker to glide from its current spot to (eLat,eLon) once, over POS_TWEEN_MS, on
// position update. No between-update motion: the marker sits at the last reported fix until
// the next one arrives. Pure interpolation, never extrapolation.
function queuePositionTween(id, marker, eLat, eLon){
  const cur = marker.getLatLng();
  if(prefersReducedMotion || !isPageVisible() ||
     haversineM(cur.lat,cur.lng,eLat,eLon) > TWEEN_SNAP_M){
    activeTweens.delete(id);
    marker.setLatLng([eLat,eLon]);
    return;
  }
  if(cur.lat===eLat && cur.lng===eLon){ activeTweens.delete(id); return; } // unchanged, stay static
  // Re-seed from the CURRENT (possibly mid-tween) position so a retarget is seamless.
  activeTweens.set(id,{ sLat:cur.lat, sLon:cur.lng, eLat, eLon, start:performance.now() });
  if(tweenRafId==null) tweenRafId = requestAnimationFrame(tweenTick);
}

function tweenTick(now){
  if(!isPageVisible()){ tweenRafId=null; return; } // resumes when the next poll re-queues
  const bounds = map.getBounds();
  activeTweens.forEach((tw,id)=>{
    const m = vehicleMarkers[id];
    if(!m){ activeTweens.delete(id); return; }
    let t = (now - tw.start) / POS_TWEEN_MS;
    if(t >= 1){ m.setLatLng([tw.eLat,tw.eLon]); activeTweens.delete(id); return; }
    if(t < 0) t = 0;
    // Off-screen: no visual benefit, jump straight to the fix and drop it.
    if(!bounds.contains(m.getLatLng()) && !bounds.contains(L.latLng(tw.eLat,tw.eLon))){
      m.setLatLng([tw.eLat,tw.eLon]); activeTweens.delete(id); return;
    }
    // easeOutQuad: decelerates into the new fix, so the update reads as a smooth settle
    // rather than a hard snap. Monotonic, so the marker stays on the segment between fixes.
    const k = t*(2-t);
    m.setLatLng([ tw.sLat+(tw.eLat-tw.sLat)*k, tw.sLon+(tw.eLon-tw.sLon)*k ]);
  });
  followPinnedIfNeeded(false);
  tweenRafId = activeTweens.size ? requestAnimationFrame(tweenTick) : null;
}

// ---- Route outline for the selected in-service vehicle ------------------------------
// Dedicated pane keeps the outline beneath the vehicle markers.
try{ map.createPane("routePane"); map.getPane("routePane").style.zIndex=350; }catch{}
let routeOutline=null; // { shapeId, layer }

function clearRouteOutline(){
  if(routeOutline?.layer){ try{ map.removeLayer(routeOutline.layer); }catch{} }
  routeOutline=null;
}
// ---- Turf: project a vehicle onto its route shape ------------------------------------
// Turf works in [lon,lat]; our shapes are [lat,lon]. We cache the turf LineString on the
// shape object (rebuilt cheaply if absent). nearestPointOnLine snaps the vehicle to the
// polyline and reports distance travelled along it, which we turn into a progress %, a
// distance-to-end, and a travelled/remaining split for the drawn outline.
function buildTurfLine(shape){
  if(shape._turf!==undefined) return shape._turf;
  if(typeof turf==="undefined" || !shape.pts || shape.pts.length<2){ shape._turf=null; return null; }
  try{ shape._turf=turf.lineString(shape.pts.map(p=>[p[1],p[0]])); }
  catch{ shape._turf=null; }
  return shape._turf;
}
// Returns {frac, alongKm, totalKm, traversed:[[lat,lon]...], remaining:[[lat,lon]...]} or null.
function projectOnRoute(shape, lat, lon){
  const line=buildTurfLine(shape);
  if(!line) return null;
  try{
    const totalKm = (shape.total!=null && shape.total>0) ? shape.total/1000 : turf.length(line,{units:"kilometers"});
    const snap = turf.nearestPointOnLine(line, turf.point([lon,lat]), {units:"kilometers"});
    const alongKm = snap.properties.location;
    const coords = line.geometry.coordinates;
    const toLL = c => c.map(x=>[x[1],x[0]]);
    const traversed = toLL(turf.lineSlice(turf.point(coords[0]), snap, line).geometry.coordinates);
    const remaining = toLL(turf.lineSlice(snap, turf.point(coords[coords.length-1]), line).geometry.coordinates);
    const frac = totalKm>0 ? Math.max(0,Math.min(1, alongKm/totalKm)) : 0;
    return {frac, alongKm, totalKm, traversed, remaining};
  }catch{ return null; }
}

function drawRouteOutline(shapeId,color,proj){
  const shape=shapeCache.get(shapeId);
  if(!shape || !shape.pts?.length){ clearRouteOutline(); return; }
  clearRouteOutline();
  const c=color||"#0a84ff";
  const layers=[ L.polyline(shape.pts,{pane:"routePane",color:"#000",opacity:0.22,weight:8,lineJoin:"round",lineCap:"round",interactive:false}) ];
  if(proj && proj.traversed?.length>1 && proj.remaining?.length>1){
    // Travelled portion dimmed, remaining portion bright, so the vehicle reads as a fill line.
    layers.push(L.polyline(proj.traversed,{pane:"routePane",color:c,opacity:0.28,weight:4,lineJoin:"round",lineCap:"round",interactive:false}));
    layers.push(L.polyline(proj.remaining,{pane:"routePane",color:c,opacity:0.95,weight:4,lineJoin:"round",lineCap:"round",interactive:false}));
  }else{
    layers.push(L.polyline(shape.pts,{pane:"routePane",color:c,opacity:0.9,weight:4,lineJoin:"round",lineCap:"round",interactive:false}));
  }
  routeOutline={ shapeId, layer:L.layerGroup(layers).addTo(map) };
}

// Progress + nearest-stop line for the pinned vehicle's popup.
function buildProgressHtml(proj, lat, lon){
  const bits=[];
  if(proj && proj.totalKm>0){
    const pct=Math.round(proj.frac*100);
    const remKm=Math.max(0, proj.totalKm-proj.alongKm);
    bits.push(`<b>Route progress:</b> ${pct}% · ${remKm.toFixed(1)} km to end`);
  }
  const ns=nearestStop(lat,lon,0.4); // within 400 m
  if(ns) bits.push(`<b>Nearest stop:</b> ${escapeHtml(ns.name)} (${ns.distM} m)`);
  return bits.length ? bits.join("<br>") : "";
}

async function showRouteOutlineFor(marker){
  if(!marker || marker.currentType==="out" || !marker.tripId){ clearRouteOutline(); if(marker) marker._progressHtml=""; return; }
  const sid=tripCache[marker.tripId]?.shape_id;
  if(!sid){ clearRouteOutline(); marker._progressHtml=""; console.warn("[shapes] no shape_id for trip", marker.tripId); setDebug("No shape_id for this trip (check /api/trips passes shape_id)"); return; }
  if(!shapeCache.has(sid)) await fetchShapes([sid]);
  if(pinnedPopup!==marker) return;                       // selection changed while fetching
  const shape=shapeCache.get(sid);
  if(!shape){ clearRouteOutline(); marker._progressHtml=""; console.warn("[shapes] empty/failed shape", sid, "- check /api/shapes?ids="+sid); setDebug("Route shape unavailable (open /api/shapes?ids="+sid+" to see _diag)"); return; }
  const ll=marker.getLatLng();
  const proj=projectOnRoute(shape, ll.lat, ll.lng);
  drawRouteOutline(sid, marker.options?.fillColor || vehicleColors.bus, proj);
  marker._progressHtml=buildProgressHtml(proj, ll.lat, ll.lng);
  refreshOpenPopup(marker);
}

// ---- Lazy shape fetching (deduped, viewport-limited, capped) -------------------------
async function fetchShapes(ids){
  const want=[...new Set(ids)].filter(id=>id && !shapeCache.has(id) && !shapePending.has(id));
  if(!want.length) return;
  want.forEach(id=>shapePending.add(id));
  for(const group of chunk(want,25)){
    const json=await safeFetch(`${shapesUrl}?ids=${group.map(encodeURIComponent).join(",")}`);
    group.forEach(id=>shapePending.delete(id));
    if(!json || json._rateLimited){ if(json&&json._rateLimited) applyRateLimitBackoff(json.retryAfterMs,"shapes"); continue; }
    const shapes=json.shapes||{};
    group.forEach(id=>ingestShape(id, shapes[id])); // null marks "tried, none" so we don't refetch
  }
}
function ensureShapesForViewport(){
  const ids=[];
  // Selected vehicle first (so its outline/following is always ready).
  if(pinnedPopup && pinnedPopup.currentType!=="out" && pinnedPopup.tripId){
    const sid=tripCache[pinnedPopup.tripId]?.shape_id;
    if(sid && !shapeCache.has(sid) && !shapePending.has(sid)) ids.push(sid);
  }
  if(map.getZoom()>=MIN_SHAPE_ZOOM){
    const b=map.getBounds();
    const seen=new Set(ids);
    for(const id in vehicleMarkers){
      if(ids.length>=SHAPE_FETCH_CAP) break;
      const m=vehicleMarkers[id];
      if(m.currentType==="out" || !m.tripId) continue;
      if(!b.contains(m.getLatLng())) continue;
      const sid=tripCache[m.tripId]?.shape_id;
      if(sid && !seen.has(sid) && !shapeCache.has(sid) && !shapePending.has(sid)){ seen.add(sid); ids.push(sid); }
    }
  }
  if(ids.length) fetchShapes(ids);
}
let _shapeViewTimer=null;
map.on("moveend zoomend",()=>{ clearTimeout(_shapeViewTimer); _shapeViewTimer=setTimeout(ensureShapesForViewport,400); });

// ===================== Stops & stations ==============================================
// Stop geometry is not in the realtime feed, so it loads once from a static stops.json
// (generate it from a current AT GTFS export with build-stops.mjs). Stations and ferry
// terminals are few and act as map landmarks, so they show across the region; bus stops
// are dense, so they only appear when zoomed right in. Only the stops inside the current
// viewport are drawn, on their own canvas pane beneath the vehicles, capped for safety.
const STOP_MIN_ZOOM_RAILFERRY = 11;
const STOP_MIN_ZOOM_BUS       = 16;
const STOP_RENDER_CAP         = 800;
let stopsData=[], stopsRailFerry=[], stopsBus=[], stopsEnabled=true;

function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

try{ map.createPane("stopsPane"); map.getPane("stopsPane").style.zIndex=250; }catch{}
const stopsRenderer=L.canvas({pane:"stopsPane",padding:0.5,tolerance:10}); // +10px hit area so tiny bus dots are easy to tap
const stopsLayer=L.layerGroup();

const STOP_STYLE={
  1:{radius:5,color:trainLineColors.STH,fill:"#fff",weight:2,label:"Rail station"},
  2:{radius:5,color:vehicleColors.ferry,fill:"#fff",weight:2,label:"Ferry terminal"},
  0:{radius:3,color:"#666",fill:"#fff",weight:1,label:"Bus stop"},
};

// Nearest stop to a point via a bbox prefilter + great-circle distance (reuses haversineM).
function nearestStop(lat,lon,maxKm){
  if(!stopsData.length) return null;
  const dLat=maxKm/111, dLon=maxKm/(111*Math.cos(lat*Math.PI/180)||1);
  let best=null,bestD=Infinity;
  for(let i=0;i<stopsData.length;i++){
    const s=stopsData[i];
    if(Math.abs(s[0]-lat)>dLat || Math.abs(s[1]-lon)>dLon) continue;
    const d=haversineM(lat,lon,s[0],s[1]);
    if(d<bestD){ bestD=d; best=s; }
  }
  if(!best || bestD>maxKm*1000) return null;
  return {name:best[3], distM:Math.round(bestD)};
}

function makeStopMarker(s){
  const st=STOP_STYLE[s[4]]||STOP_STYLE[0];
  const m=L.circleMarker([s[0],s[1]],{renderer:stopsRenderer,radius:st.radius,color:st.color,weight:st.weight,fillColor:st.fill,fillOpacity:0.95,opacity:1,interactive:true,bubblingMouseEvents:false});
  m.bindPopup(`<div style="font-size:0.9em;line-height:1.3;"><b>${escapeHtml(s[3])}</b><br>Stop ${escapeHtml(String(s[2]||"—"))} &middot; ${st.label}</div>`,{maxWidth:220,className:"vehicle-popup"});
  // Open on click/tap (bindPopup's default). Works on both desktop and touch and stays open
  // until dismissed, unlike the old hover behaviour which vanished as the cursor moved off.
  return m;
}

function renderStopsForViewport(){
  if(!stopsEnabled || !stopsData.length){ stopsLayer.clearLayers(); return; }
  const z=map.getZoom();
  const showRailFerry=z>=STOP_MIN_ZOOM_RAILFERRY;
  const showBus=z>=STOP_MIN_ZOOM_BUS;
  stopsLayer.clearLayers();
  if(!showRailFerry && !showBus) return;
  const b=map.getBounds().pad(0.2);
  const south=b.getSouth(),north=b.getNorth(),west=b.getWest(),east=b.getEast();
  const inView=s=>s[0]>=south&&s[0]<=north&&s[1]>=west&&s[1]<=east;
  // Stations/ferries first (always drawn when visible), then bus stops up to the cap.
  if(showRailFerry) for(const s of stopsRailFerry){ if(inView(s)) stopsLayer.addLayer(makeStopMarker(s)); }
  if(showBus){ let n=0; for(const s of stopsBus){ if(!inView(s)) continue; stopsLayer.addLayer(makeStopMarker(s)); if(++n>=STOP_RENDER_CAP) break; } }
}

let _stopsTimer=null;
function scheduleStopsRender(){ clearTimeout(_stopsTimer); _stopsTimer=setTimeout(renderStopsForViewport,250); }
map.on("moveend zoomend", scheduleStopsRender);

function setStopsEnabled(on){
  stopsEnabled=on;
  if(on){ if(!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); renderStopsForViewport(); }
  else { map.removeLayer(stopsLayer); stopsLayer.clearLayers(); }
}

// Stop geometry is loaded directly from AT CSV exports hosted alongside the site, so
// refreshing the data is just "replace the CSV and reload" with no build step. Drop the
// AT downloads in as these filenames (extra files, e.g. a ferry export, can be appended).
// Each CSV carries WGS84 lat/lon and a Mode column, which is all we need; train platforms
// are collapsed to one marker per parent station.
const STOP_CSV_FILES = ["stops_train.csv", "stops_bus.csv", "stops_ferry.csv"];

// Quote-aware single-line CSV splitter (handles "a,b" and escaped "").
function csvSplitLine(line){
  const out=[]; let cur="", inQ=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(inQ){ if(c==='"'){ if(line[i+1]==='"'){ cur+='"'; i++; } else inQ=false; } else cur+=c; }
    else { if(c==='"') inQ=true; else if(c===","){ out.push(cur); cur=""; } else cur+=c; }
  }
  out.push(cur); return out;
}
const _normHdr = h => h.toLowerCase().replace(/[^a-z0-9]/g,"");
function _pickCol(idx, cands){ for(const c of cands){ if(idx[c]!=null) return idx[c]; } return -1; }

// Parse one AT stops CSV into {lat,lon,name,code,type,parent} rows. Header matching is
// case/space-insensitive so the differing bus ("Stop Latitude") and train ("STOPLAT")
// schemas both work. Mode column sets type: 1 rail, 2 ferry, 0 bus.
function parseStopsCsv(text){
  const out=[];
  const rows=text.replace(/^\uFEFF/,"").split(/\r?\n/);
  if(rows.length<2) return out;
  const header=csvSplitLine(rows[0]).map(_normHdr);
  const idx={}; header.forEach((h,i)=>{ if(idx[h]==null) idx[h]=i; });
  const ci={
    lat:    _pickCol(idx,["stoplat","stoplatitude","latitude","lat"]),
    lon:    _pickCol(idx,["stoplon","stoplongitude","longitude","lon","lng"]),
    name:   _pickCol(idx,["stopname","name"]),
    code:   _pickCol(idx,["stopcode","code"]),
    mode:   _pickCol(idx,["mode"]),
    parent: _pickCol(idx,["parentstation","parent"]),
  };
  if(ci.lat<0||ci.lon<0||ci.name<0) return out;
  for(let i=1;i<rows.length;i++){
    if(!rows[i]) continue;
    const f=csvSplitLine(rows[i]);
    const lat=parseFloat(f[ci.lat]), lon=parseFloat(f[ci.lon]);
    if(!isFinite(lat)||!isFinite(lon)) continue;
    const name=(f[ci.name]||"").trim(); if(!name) continue;
    const modeStr=ci.mode>=0?(f[ci.mode]||""):"";
    const type=/train|rail/i.test(modeStr)?1:(/ferry/i.test(modeStr)?2:0);
    out.push({
      lat, lon, name,
      code:   ci.code>=0?(f[ci.code]||"").trim():"",
      parent: ci.parent>=0?(f[ci.parent]||"").trim():"",
      type,
    });
  }
  return out;
}

// Bus stops are kept as-is; rail/ferry collapse to one entry per parent station (or cleaned
// name), dropping per-platform duplicates and the trailing platform number in the label.
function dedupeStops(rows){
  const seen=new Set(), res=[];
  for(const s of rows){
    if(s.type===0){ res.push([s.lat,s.lon,s.code,s.name,0]); continue; }
    const clean=s.name.replace(/\s+(platform\s*)?\d+$/i,"").trim();
    const key=s.type+"|"+(s.parent||clean.toLowerCase());
    if(seen.has(key)) continue;
    seen.add(key);
    res.push([s.lat,s.lon,s.code,clean,s.type]);
  }
  return res;
}

function afterStopsLoaded(){
  stopsRailFerry=stopsData.filter(s=>s[4]!==0);
  stopsBus=stopsData.filter(s=>s[4]===0);
  if(stopsEnabled){ if(!map.hasLayer(stopsLayer)) map.addLayer(stopsLayer); renderStopsForViewport(); }
}

async function loadStops(){
  const rows=[];
  for(const file of STOP_CSV_FILES){
    try{
      const res=await fetch(file,{cache:"no-cache"}); // revalidate so new commits show up
      if(!res.ok) continue;
      const parsed=parseStopsCsv(await res.text());
      if(parsed.length) rows.push(...parsed);
    }catch{}
  }
  if(rows.length){
    stopsData=dedupeStops(rows);
    const c=stopsData.reduce((a,s)=>(a[s[4]]=(a[s[4]]||0)+1,a),{});
    setDebug(`Stops loaded: ${c[1]||0} rail, ${c[2]||0} ferry, ${c[0]||0} bus`);
    afterStopsLoaded();
    return;
  }
  // Fallback: prebuilt stops.json from the older build-script workflow, if present.
  try{
    const r=await fetch("stops.json",{cache:"force-cache"});
    if(r.ok){ const j=await r.json(); if(Array.isArray(j?.stops)){ stopsData=j.stops; afterStopsLoaded(); return; } }
  }catch{}
  setDebug("No stop data found (add stops_train.csv / stops_bus.csv)");
}

// ===================== Rail line geometry (optional GeoJSON) ==========================
// The AT "Train Route" CSV export has attributes but no geometry, so route lines come from
// a GeoJSON export of the same layer (Download > GeoJSON on the AT Open GIS Data portal,
// or append ?f=geojson to the layer's REST query). Same replaceable-file workflow: drop in
// train_routes.geojson, reload, lines redraw. Lines are coloured by line code and sit on
// their own pane beneath everything else. Absent file -> layer simply never appears.
const RAIL_LINES_FILE="train_routes.geojson";
let railLinesLayer=null, railLinesEnabled=true;
const RAIL_DEDUPE_BY_LINE=true; // keep only the longest pattern per line code (clean overview)

try{ map.createPane("railPane"); map.getPane("railPane").style.zIndex=240; }catch{}

function railLineColor(props){
  const p=props||{};
  const s=`${p.ROUTENUMBER??p.routenumber??p.ROUTE??""} ${p.ROUTENAME??p.routename??""}`.toUpperCase();
  if(s.includes("STH")||s.includes("SOUTH")) return trainLineColors.STH;
  if(s.includes("WEST")) return trainLineColors.WEST;
  if(s.includes("EAST")) return trainLineColors.EAST;
  if(s.includes("ONE")||s.includes("ONEHUNGA")) return trainLineColors.ONE;
  if(s.includes("HUIA")||s.includes("HAMILTON")) return trainLineColors.HUIA;
  return vehicleColors.train;
}

async function loadRailLines(){
  let gj=null;
  try{
    const res=await fetch(RAIL_LINES_FILE,{cache:"no-cache"}); // revalidate so new commits show up
    if(!res.ok) return;
    gj=await res.json();
  }catch{ return; }
  if(railLinesLayer){ try{ map.removeLayer(railLinesLayer); }catch{} railLinesLayer=null; }

  // AT's export carries every pattern variant (dozens of overlapping Southern Line copies),
  // so for a clean network overview keep only the longest pattern per line code. Works the
  // same whether the file is the slim shipped one or a raw multi-pattern AT export.
  const feats=(gj?.features||[]).filter(f=>{ const m=String(f?.properties?.MODE??f?.properties?.mode??"").toLowerCase(); return !m || m.includes("train")||m.includes("rail"); });
  const keep=new Set();
  if(RAIL_DEDUPE_BY_LINE){
    const longest=new Map(); // line code -> {len, id}
    feats.forEach(f=>{
      const p=f.properties||{};
      const code=String(p.ROUTENUMBER??p.routenumber??p.OBJECTID??Math.random()).toUpperCase();
      const len=Number(p.Shape__Length??p.shape__length??0)||0;
      const id=p.OBJECTID??p.objectid??f;
      const cur=longest.get(code);
      if(!cur || len>cur.len) longest.set(code,{len,id});
    });
    longest.forEach(v=>keep.add(v.id));
  }
  const keepFeature=f=>{ const p=f.properties||{}; return !RAIL_DEDUPE_BY_LINE || keep.has(p.OBJECTID??p.objectid??f); };

  try{
    railLinesLayer=L.geoJSON(gj,{
      pane:"railPane",
      filter:f=>{ const m=String(f?.properties?.MODE??f?.properties?.mode??"").toLowerCase(); return (!m || m.includes("train")||m.includes("rail")) && keepFeature(f); },
      style:f=>({color:railLineColor(f.properties),weight:3,opacity:0.65,lineJoin:"round",lineCap:"round"}),
      onEachFeature:(f,layer)=>{
        const p=f.properties||{};
        const nm=p.ROUTENAME||p.routename||p.ROUTENUMBER||p.routenumber||"Train route";
        layer.bindTooltip(String(nm),{sticky:true});
      },
    });
    if(railLinesEnabled) railLinesLayer.addTo(map);
    setDebug(`Rail lines loaded (${railLinesLayer.getLayers().length} segments)`);
  }catch(e){ console.warn("[rail] bad GeoJSON", e); }
}

function setRailLinesEnabled(on){
  railLinesEnabled=on;
  if(!railLinesLayer) return;
  if(on){ if(!map.hasLayer(railLinesLayer)) railLinesLayer.addTo(map); }
  else map.removeLayer(railLinesLayer);
}



// Popups are built only when actually opened. With 1000+ vehicles, building popup HTML for
// every marker every poll is pure waste since nobody is looking at most of them. We store
// the raw fields on the marker and assemble the HTML in the popupopen handler / on refresh.
function buildPopupForMarker(m){
  const base=buildPopup(
    m.routeName||"Unknown", m.destination||"Unknown", m.vehicleLabel||"N/A",
    m.busType||"", m.licensePlate||"N/A", m.speedStr||"", m.scheduleLine||"",
    m.occupancy||"", m.bikesLine||"", m.extraLines||""
  );
  return base
    + (m._progressHtml?`<div style="font-size:0.9em;line-height:1.3;margin-top:3px;">${m._progressHtml}</div>`:"")
    + (m.pairedTo?`<br><b>Paired to:</b> ${m.pairedTo} (6-car)`:"");
}
function refreshOpenPopup(m){
  if(m && m.isPopupOpen && m.isPopupOpen()) m.setPopupContent(buildPopupForMarker(m));
}

// ===================== Labelled canvas markers =====================
// Vehicles are drawn straight onto Leaflet's shared canvas (preferCanvas), so labels are
// drawn onto that same canvas rather than as DOM nodes. This keeps the route code "inside"
// the marker with zero extra DOM and redraws for free inside the existing tween/redraw
// pipeline (setLatLng -> canvas _draw -> layer._updatePath). At low zoom we fall back to
// the plain dot to avoid clutter.

// Short code shown in the pill. Trains collapse to the line code (STH/EAST/WEST/ONE);
// buses use the route_short_name (the bus number). Ferry/out-of-service get no label.
function badgeForRoute(typeKey, routeName){
  if(typeKey==="train"){
    const s=(routeName||"").toUpperCase();
    if(s.includes("STH")||s.includes("SOUTH")) return "STH";
    if(s.includes("WEST")) return "WEST";
    if(s.includes("EAST")) return "EAST";
    if(s.includes("ONE")||s.includes("ONEHUNGA")) return "ONE";
    return (s.split(/\s+/)[0]||"").slice(0,4) || "TRN";
  }
  if(typeKey==="bus"){
    const s=(routeName||"").trim();
    if(!s || s==="Unknown" || s==="Out of service") return "";
    return s.length>6 ? s.slice(0,6) : s; // guard against a route_long_name fallback
  }
  return ""; // ferry / out -> plain dot
}

// Pick black or white text for legibility over the pill's fill colour.
function badgeTextColor(hex){
  const c=(hex||"").replace("#","");
  if(c.length<6) return "#fff";
  const r=parseInt(c.slice(0,2),16), g=parseInt(c.slice(2,4),16), b=parseInt(c.slice(4,6),16);
  const L=(0.299*r+0.587*g+0.114*b)/255;
  return L>0.6 ? "#111" : "#fff";
}

function roundRectPath(ctx,x,y,w,h,r){
  r=Math.min(r,w/2,h/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

// Badge geometry is computed independently of the render context (off-screen measuring
// canvas) so it is available in _updateBounds, which runs on project/zoom before any draw.
// Font auto-shrinks a step for longer codes so the text always fits the pill.
const _badgeMeasureCtx = document.createElement("canvas").getContext("2d");
// Fixed pill size for visual consistency: every badge is the same width/height regardless of
// code length. Longer codes (e.g. "WEST") get a slightly smaller font so they still fit,
// while short codes (e.g. "70") keep the base size, centred in the same pill.
const BADGE_W=36, BADGE_H=16, BADGE_PADX=5, BADGE_FONT_MAX=11, BADGE_FONT_MIN=8;
function badgeFontStr(fs){ return `700 ${fs}px -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Arial,sans-serif`; }
function badgeMetrics(text){
  const t=text||"";
  const inner=BADGE_W-BADGE_PADX*2;
  let fs=BADGE_FONT_MAX;
  if(_badgeMeasureCtx){
    for(; fs>BADGE_FONT_MIN; fs--){ _badgeMeasureCtx.font=badgeFontStr(fs); if(_badgeMeasureCtx.measureText(t).width<=inner) break; }
  }else{
    const est=t.length*BADGE_FONT_MAX*0.62;            // rough fallback if no 2D context
    if(est>inner) fs=Math.max(BADGE_FONT_MIN, Math.floor(BADGE_FONT_MAX*inner/est));
  }
  return {W:BADGE_W,H:BADGE_H,hw:BADGE_W/2,hh:BADGE_H/2,fontSize:fs};
}


const LabeledCircleMarker = L.CircleMarker.extend({
  _labelled:function(){ return !!(this.badgeText && this._map && this._map.getZoom()>=LABEL_MIN_ZOOM); },
  // Cache pill geometry, recomputing only when the text changes.
  _badgeMetrics:function(){
    if(this._bm_text!==this.badgeText){ this._bm_text=this.badgeText; this._bm=this.badgeText?badgeMetrics(this.badgeText):null; }
    return this._bm;
  },
  _updatePath:function(){
    if(this._labelled()) this._drawBadge();
    else { this._badgeBox=null; this._renderer._updateCircle(this); }
  },
  _drawBadge:function(){
    const r=this._renderer, ctx=r&&r._ctx, p=this._point;
    if(!ctx||!p) return;
    if(this._empty && this._empty()){ this._badgeBox=null; return; } // off-screen: same test stock circles use
    const text=this.badgeText, m=this._badgeMetrics();
    if(!m){ this._renderer._updateCircle(this); return; }
    const x=p.x-m.hw, y=p.y-m.hh;
    this._badgeBox={hw:m.hw, hh:m.hh};            // rectangular hit area for clicks/hover
    ctx.save();
    roundRectPath(ctx,x,y,m.W,m.H,m.H/2);
    ctx.fillStyle=this._fillColor||vehicleColors.bus;
    ctx.fill();
    ctx.lineWidth=this.options.weight||1;         // thickens to 3 on search highlight
    ctx.strokeStyle="rgba(0,0,0,0.55)";
    ctx.stroke();
    ctx.font=badgeFontStr(m.fontSize);
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.fillStyle=badgeTextColor(this._fillColor||vehicleColors.bus);
    ctx.fillText(text,p.x,p.y+0.5);
    ctx.restore();
  },
  _containsPoint:function(point){
    if(this._badgeBox){
      const b=this._badgeBox, t=this._clickTolerance();
      return Math.abs(point.x-this._point.x)<=b.hw+t && Math.abs(point.y-this._point.y)<=b.hh+t;
    }
    return point.distanceTo(this._point)<=this._radius+this._clickTolerance();
  }
});

function addOrUpdateMarker(id,lat,lon,color,type,tripId,fields={}){
  const isMobile=window.innerWidth<=600;
  const baseRadius=isMobile?6:5;
  const popupOpts={maxWidth:isMobile?220:260,className:"vehicle-popup"};

  if(vehicleMarkers[id]){
    const m=vehicleMarkers[id];
    const prevType=m.currentType;            // before fields overwrite it
    queuePositionTween(id,m,lat,lon);        // glide once toward the new reported fix
    if(m._fillColor!==color){ m.setStyle({fillColor:color}); m._fillColor=color; }
    m.tripId=tripId;
    if(m._baseRadius==null) m._baseRadius=baseRadius;
    Object.assign(m,fields);
    refreshOpenPopup(m);                      // only rebuilds HTML if this popup is open

    // Only touch layer membership when the mode actually changed (removing/re-adding to
    // four layer groups every poll for every vehicle is expensive and pointless).
    if(prevType!==type){
      Object.values(vehicleLayers).forEach(l=>l.removeLayer(m));
      (vehicleLayers[type]||vehicleLayers.out).addLayer(m);
    }
  }else{
    const marker=new LabeledCircleMarker([lat,lon],{radius:baseRadius,fillColor:color,color:"#000",weight:1,opacity:1,fillOpacity:0.9});
    marker._baseRadius=baseRadius;
    marker._fillColor=color;
    Object.assign(marker,fields);             // store fields BEFORE first draw/bind so label + popup build
    (vehicleLayers[type]||vehicleLayers.out).addLayer(marker);
    marker.bindPopup("",popupOpts);           // content is materialised lazily on open

    if(!marker._eventsBound){
      marker.on("popupopen",function(){ this.setPopupContent(buildPopupForMarker(this)); });
      marker.on("mouseover",function(){ if(pinnedPopup!==this) this.openPopup(); });
      marker.on("mouseout", function(){ if(pinnedPopup!==this) this.closePopup(); });
      marker.on("click",    function(e){
        if(pinnedPopup&&pinnedPopup!==this) pinnedPopup.closePopup();
        pinnedPopup=this; pinnedFollow=true;
        this.openPopup();
        showRouteOutlineFor(this);
        e?.originalEvent?.stopPropagation?.();
      });
      marker._eventsBound=true;
    }

    marker.tripId=tripId;
    vehicleMarkers[id]=marker;
  }
}
function updateVehicleCount(){
  let busCount=0, trainCount=0, ferryCount=0;
  for(const id in vehicleMarkers){
    switch(vehicleMarkers[id].currentType){
      case "bus":   busCount++;   break;
      case "train": trainCount++; break;
      case "ferry": ferryCount++; break;
    }
  }
  const el=document.getElementById("vehicle-count"); if(el) el.textContent=`Buses: ${busCount}, Trains: ${trainCount}, Ferries: ${ferryCount}`;
}

(function injectExtraStyle(){
  const style=document.createElement("style");
  style.textContent=`.veh-highlight{stroke:#333;stroke-width:3;}`;
  document.head.appendChild(style);
})();

function updateControlsHeight() {
  const el = document.getElementById("controls");
  if (!el) return;
  const h = Math.ceil(el.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--controls-height", h + "px");
}
window.addEventListener("resize", updateControlsHeight);
window.addEventListener("orientationchange", updateControlsHeight);
window.addEventListener("load", updateControlsHeight);
const __controlsRO = new ResizeObserver(updateControlsHeight);
document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("controls");
  if (el) __controlsRO.observe(el);
});

function normalizeFleetLabel(s){return (s||"").toString().trim().replace(/\s+/g,"").toUpperCase();}
function normalizeRouteKey(s){return (s||"").toString().trim().replace(/\s+/g,"").toUpperCase();}
function onlyDigits(s){return (s||"").replace(/\D/g,"");}
function clearRouteHighlights(){
  Object.values(vehicleMarkers).forEach(m=>{
    if(m._isRouteHighlighted){
      try{ if(typeof m.setRadius==="function" && m._baseRadius!=null) m.setRadius(m._baseRadius); m.setStyle({weight:1}); }catch{}
      m._isRouteHighlighted=false;
    }
  });
}
function highlightMarkers(markers){
  clearRouteHighlights();
  const bounds=[];
  markers.forEach(m=>{
    try{ if(typeof m.setRadius==="function" && m._baseRadius!=null) m.setRadius(m._baseRadius+2); m.setStyle({weight:3}); m._isRouteHighlighted=true; bounds.push(m.getLatLng()); }catch{}
  });
  if(bounds.length>0) map.fitBounds(L.latLngBounds(bounds),{padding:[40,40]});
}

function resolveQueryToMarkers(raw){
  const q=(raw||"").trim();
  if(!q) return {type:"none"};
  const fleetKey=normalizeFleetLabel(q);
  const digitKey=onlyDigits(q);
  if(vehicleIndexByFleet.has(fleetKey)){
    return {type:"fleet", exemplar: vehicleIndexByFleet.get(fleetKey)};
  }
  if(oosIndexByFleet.has(fleetKey)){
    return {type:"fleet", exemplar: oosIndexByFleet.get(fleetKey)};
  }
  const routeKey=normalizeRouteKey(q);
  if(routeIndex.has(routeKey)){
    const set=routeIndex.get(routeKey);
    const list=[...set];
    return {type:"route", markers:list, exemplar:list[0]||null};
  }
  for(const [key,marker] of vehicleIndexByFleet.entries()){
    if(key.startsWith(fleetKey)) return {type:"fleet", exemplar:marker};
  }
  for(const [key,marker] of oosIndexByFleet.entries()){
    if(key.startsWith(fleetKey)) return {type:"fleet", exemplar:marker};
  }
  if(digitKey){
    for(const [key,marker] of vehicleIndexByFleet.entries()){
      if(onlyDigits(key)===digitKey) return {type:"fleet", exemplar:marker};
    }
    for(const [key,marker] of oosIndexByFleet.entries()){
      if(onlyDigits(key)===digitKey) return {type:"fleet", exemplar:marker};
    }
  }
  for(const [rk,set] of routeIndex.entries()){
    if(rk.startsWith(routeKey)){
      const list=[...set];
      return {type:"route", markers:list, exemplar:list[0]||null};
    }
  }
  return {type:"none"};
}
function isMobileScreen(){ return window.innerWidth <= 600; }

// Search control 
const SearchControl=L.Control.extend({
  options:{position:"topleft"},
  onAdd:function(){
    const wrapper=L.DomUtil.create("div","leaflet-control search-wrapper");
    const div=L.DomUtil.create("div","leaflet-control search-control",wrapper);

    const btn=L.DomUtil.create("button","search-icon-btn",div);
    btn.type="button"; btn.title="Search";
    btn.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;

    const input=L.DomUtil.create("input","search-input",div);
    input.type="text"; input.placeholder="search here"; input.setAttribute("enterkeyhint","search");

    const cancel=L.DomUtil.create("button","search-cancel",div);
    cancel.type="button"; cancel.textContent="Cancel";

    const sugg=L.DomUtil.create("div","search-suggestions",div);

    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.disableScrollPropagation(wrapper);
    div.classList.remove("expanded");

    function openAndPin(m) {
      if (!m) return;
      const ll = m.getLatLng();
      const targetZoom = Math.max(map.getZoom(), 14);

      if (pinnedPopup && pinnedPopup !== m) pinnedPopup.closePopup();
      pinnedPopup = m;
      pinnedFollow = true;
      showRouteOutlineFor(m);

      const needMove =
        map.getZoom() < targetZoom ||
        !map.getBounds().pad(-0.25).contains(ll);

      const doOpen = () => {
        try {
          m.openPopup();
          m.bringToFront?.();
          setTimeout(() => { try { m.bringToFront?.(); } catch {} }, 0);
        } catch {}
      };

      if (needMove) {
        let done = false;
        const once = () => { if (done) return; done = true; map.off("moveend", once); doOpen(); };
        map.once("moveend", once);
        map.setView(ll, targetZoom, { animate: true });
        setTimeout(once, 600);
      } else {
        doOpen();
      }
    }

    function expand(){ div.classList.add("expanded"); input.focus({ preventScroll:true }); renderSuggestions(input.value); }
    function collapse(opts = { preservePopup: false }) {
      div.classList.remove("expanded"); input.value = ""; sugg.innerHTML = ""; clearRouteHighlights();
      if (!opts.preservePopup && pinnedPopup) { pinnedPopup.closePopup(); pinnedPopup = null; pinnedFollow=false; clearRouteOutline(); }
    }

    btn.addEventListener("click", ()=> { if(div.classList.contains("expanded")) collapse({ preservePopup: !!pinnedPopup }); else expand(); });
    cancel.addEventListener("click", ()=> collapse({ preservePopup: !!pinnedPopup }));

    let blurTimer=null;
    input.addEventListener("blur", ()=>{ if(!div.classList.contains("expanded")) return; blurTimer=setTimeout(()=>{ if(div.classList.contains("expanded")) collapse({ preservePopup: !!pinnedPopup }); }, 250); });
    input.addEventListener("focus", ()=> { if(blurTimer){ clearTimeout(blurTimer); blurTimer=null; } });

    let debounceId=null;
    input.addEventListener("input",()=>{ if(debounceId) clearTimeout(debounceId); debounceId=setTimeout(()=>renderSuggestions(input.value),140); });

    input.addEventListener("keydown",e=>{
      if(e.key==="Enter"){
        e.preventDefault();
        const res=resolveQueryToMarkers(input.value);
        if(res.type==="fleet" && res.exemplar){
          if(blurTimer){ clearTimeout(blurTimer); blurTimer=null; }
          openAndPin(res.exemplar); clearRouteHighlights(); collapse({ preservePopup: true });
        }else if(res.type==="route"){
          highlightMarkers(res.markers);
          if(res.exemplar){ if(blurTimer){ clearTimeout(blurTimer); blurTimer=null; } openAndPin(res.exemplar); }
          collapse({ preservePopup: true });
        }else{
          clearRouteHighlights(); collapse({ preservePopup: !!pinnedPopup });
        }
      }else if(e.key==="Escape"){
        e.preventDefault(); collapse({ preservePopup: !!pinnedPopup });
      }
    });

    function onDocDown(ev){
      if(!div.classList.contains("expanded")) return;
      if(!wrapper.contains(ev.target)){
        if(isMobileScreen()){
          setTimeout(()=>{ if(!wrapper.contains(document.activeElement)) collapse({ preservePopup: !!pinnedPopup }); },120);
        }else{
          collapse({ preservePopup: !!pinnedPopup });
        }
      }
    }
    document.addEventListener("mousedown",onDocDown,{passive:true});
    document.addEventListener("touchstart",onDocDown,{passive:true});

    function renderSuggestions(raw){
      const q=(raw||"").trim();
      if(!div.classList.contains("expanded")) return;
      if(!q){ sugg.innerHTML=""; sugg.style.display="none"; return; }
      sugg.style.display="block";
      const qNorm=q.replace(/\s+/g,"").toUpperCase();

      const fleets=[], routesList=[], seen=new Set();
      for(const [label] of vehicleIndexByFleet.entries()){
        if(label.startsWith(qNorm) && !seen.has(label)){ fleets.push({label}); seen.add(label); if(fleets.length>=8) break; }
      }
      if(fleets.length<8){
        for(const [label] of oosIndexByFleet.entries()){
          if(label.startsWith(qNorm) && !seen.has(label)){ fleets.push({label}); seen.add(label); if(fleets.length>=8) break; }
        }
      }
      for(const [rk,set] of routeIndex.entries()){
        if(rk.startsWith(qNorm)){ routesList.push({rk,count:set.size}); if(routesList.length>=8) break; }
      }

      const html=[];
      if(fleets.length){
        html.push(`<div class="suggestion-section">Fleets</div>`);
        fleets.forEach(it=>html.push(`<div class="suggestion-item" data-kind="fleet" data-id="${it.label}"><span>${it.label}</span><span class="suggestion-meta">vehicle</span></div>`));
      }
      if(routesList.length){
        html.push(`<div class="suggestion-section">Routes</div>`);
        routesList.forEach(it=>html.push(`<div class="suggestion-item" data-kind="route" data-id="${it.rk}"><span>${it.rk}</span><span class="suggestion-meta">${it.count} vehicle${it.count===1?"":"s"}</span></div>`));
      }
      sugg.innerHTML=html.join("");

      sugg.querySelectorAll(".suggestion-item").forEach(el=>{
        el.addEventListener("pointerup",(ev)=>{
          ev.preventDefault(); ev.stopPropagation();
          const kind=el.getAttribute("data-kind");
          const id=el.getAttribute("data-id");
          if(kind==="fleet"){
            const m=vehicleIndexByFleet.get(id) || oosIndexByFleet.get(id);
            if(m){ if(blurTimer){ clearTimeout(blurTimer); blurTimer=null; } openAndPin(m); clearRouteHighlights(); collapse({ preservePopup: true }); }
            else{ collapse({ preservePopup: !!pinnedPopup }); }
          }else if(kind==="route"){
            const set=routeIndex.get(id);
            if(set&&set.size){ const list=[...set]; highlightMarkers(list); if(blurTimer){ clearTimeout(blurTimer); blurTimer=null; } openAndPin(list[0]); collapse({ preservePopup: true }); }
            else{ collapse({ preservePopup: !!pinnedPopup }); }
          }else{
            collapse({ preservePopup: !!pinnedPopup });
          }
        },{passive:false});
      });
    }

    return wrapper;
  }
});
map.addControl(new SearchControl());

async function fetchTripsBatch(tripIds){
  const idsToFetch=tripIds.filter(t=>t && !tripCache[t]); if(!idsToFetch.length) return;
  for(const ids of chunk([...new Set(idsToFetch)],100)){
    const tripJson=await safeFetch(`${tripsUrl}?ids=${ids.join(",")}`);
    if(!tripJson || tripJson._rateLimited){ if(tripJson&&tripJson._rateLimited) applyRateLimitBackoff(tripJson.retryAfterMs,"trips"); continue; }
    if(tripJson?.data?.length>0){
      const freshTrips=[];
      tripJson.data.forEach(t=>{
        const a=t.attributes;
        if(a){
          const obj={trip_id:a.trip_id,trip_headsign:a.trip_headsign||"N/A",route_id:a.route_id,bikes_allowed:a.bikes_allowed,shape_id:a.shape_id};
          tripCache[a.trip_id]=obj;
          freshTrips.push(obj);
        }
      });
      idbPutTrips(freshTrips); // persist so future sessions skip /api/trips for these

      // Fill in the route/destination now that the trip is known, then refresh only the
      // popup that happens to be open. No per-vehicle HTML building otherwise.
      ids.forEach(tid=>{
        const trip=tripCache[tid]; if(!trip) return;
        const ms=markersByTrip.get(tid); if(!ms||!ms.length) return;
        const r=routes[trip.route_id]||{};
        const routeName=r.route_short_name||r.route_long_name||"Unknown";
        const destination=trip.trip_headsign||r.route_long_name||"Unknown";
        ms.forEach(m=>{ m.routeName=routeName; m.destination=destination; m.badgeText=badgeForRoute(m.currentType,routeName); m.redraw(); refreshOpenPopup(m); });
      });
    }
  }
}

function pairAMTrains(inSvc,outOfService){
  const pairs=[], used=new Set();
  inSvc.forEach(inT=>{
    let best=null, bestDist=Infinity;
    outOfService.forEach(o=>{
      if(used.has(o.vehicleId)) return;
      const dx=inT.lat-o.lat, dy=inT.lon-o.lon, dist=Math.sqrt(dx*dx+dy*dy)*111000;
      if(dist<=200 && Math.abs(inT.speedKmh-o.speedKmh)<=15){ if(dist<bestDist){bestDist=dist; best=o;} }
    });
    if(best){ used.add(best.vehicleId); pairs.push({inTrain:inT,outTrain:best}); }
  });
  pairs.forEach(p=>{
    const inColor=p.inTrain.color||vehicleColors.train;
    const outM=vehicleMarkers[p.outTrain.vehicleId], inM=vehicleMarkers[p.inTrain.vehicleId];
    if(outM){ outM.setStyle({fillColor:inColor}); outM._fillColor=inColor; outM.pairedTo=p.inTrain.vehicleLabel; refreshOpenPopup(outM); }
    if(inM) inM.pairedTo=p.outTrain.vehicleLabel;
  });
  return pairs;
}

function renderFromCache(c){
  if(!c) return;
  c.forEach(v=>addOrUpdateMarker(v.vehicleId,v.lat,v.lon,v.color,v.typeKey,v.tripId,{
    currentType:v.typeKey,vehicleLabel:v.vehicleLabel||"",licensePlate:v.licensePlate||"",busType:v.busType||"",speedStr:v.speedStr||"",scheduleLine:v.scheduleLine||"",occupancy:v.occupancy||"",bikesLine:v.bikesLine||"",routeName:v.routeName||"Unknown",destination:v.destination||"Unknown",extraLines:v.extraLines||"",badgeText:v.badgeText??badgeForRoute(v.typeKey,v.routeName||"")
  }));
  const ts = c[0]?.ts || Date.now();
  setDebug(`Showing cached data (last update: ${new Date(ts).toLocaleTimeString()})`);
  setLastUpdateTs(ts);
  updateVehicleCount();
}

async function fetchVehicles(opts = { ignoreBackoff: false, __retryOnce:false }){
  const ignoreBackoff = !!opts.ignoreBackoff;
  const now = Date.now();
  const realtimeBlocked = (!ignoreBackoff && backoff.realtime.until && now < backoff.realtime.until);
  if(!isPageVisible() || vehiclesInFlight || realtimeBlocked) return;
  vehiclesInFlight=true;

  const watchdogMs = 10000;
  let watchdog;
  try{
    vehiclesAbort?.abort?.();
    vehiclesAbort=new AbortController();
    watchdog = setTimeout(()=>{ try{ vehiclesAbort.abort(); }catch{} }, watchdogMs);

    const json=await safeFetch(realtimeUrl,{signal:vehiclesAbort.signal});
    if(!json) return;
    if(json._rateLimited){
      applyRateLimitBackoff(json.retryAfterMs,"realtime");
      if (!opts.__retryOnce) {
        setTimeout(()=>{ fetchVehicles({ ignoreBackoff:true, __retryOnce:true }); }, Math.min(json.retryAfterMs || 3000, 5000));
      }
      return;
    }

    backoff.realtime.ms = Math.floor(backoff.realtime.ms/2);
    if(backoff.realtime.ms < 4000) backoff.realtime.ms = 0;
    backoff.realtime.until = 0;

    const vehicles=json?.response?.entity||json?.entity||[];
    const newIds=new Set(), inServiceAM=[], outOfServiceAM=[], allTripIds=[], cachedState=[];
    vehicleIndexByFleet.clear(); routeIndex.clear(); oosIndexByFleet.clear(); markersByTrip.clear();

    // Schedule adherence: prefer trip_update entities already in the combined feed (free).
    // If the feed carries vehicles but no trip updates, fall back to the dedicated feed.
    let delayMap=buildDelayMap(vehicles);
    const hasVehicles=vehicles.some(e=>e.vehicle);
    if(delayMap.size===0 && hasVehicles) useSeparateTripUpdates=true;
    if(useSeparateTripUpdates){
      const sep=await fetchTripUpdatesDelays();
      if(sep && sep.size) delayMap=sep;
    }

    vehicles.forEach(v=>{
      const vehicleId=v.vehicle?.vehicle?.id; if(!v.vehicle||!v.vehicle.position||!vehicleId) return; newIds.add(vehicleId);
      const lat=v.vehicle.position.latitude, lon=v.vehicle.position.longitude;
      const vehicleLabel=v.vehicle.vehicle?.label||"N/A", licensePlate=v.vehicle.vehicle?.license_plate||"N/A";
      const operator=v.vehicle.vehicle?.operator_id||(vehicleLabel.match(/^[A-Za-z]+/)?.[0]??"");
      const vehicleNumber=(()=>{const d=Number(vehicleLabel.replace(/\D/g,"")); return !isNaN(d)&&d>0?d:(Number(vehicleLabel)||Number(vehicleLabel.slice(2))||0);})();

      const routeId=v.vehicle?.trip?.route_id, tripId=v.vehicle?.trip?.trip_id;
      const rType=routes[routeId]?.route_type;
      const isTrain=rType===2, isFerry=rType===4, isAM=vehicleLabel.startsWith("AM");

      // ---- Speed: derive from fix-to-fix motion (robust), feed value as fallback ----
      const fixTsMs=(()=>{ const t=toNum(v.vehicle?.timestamp); return t?Math.round(t*1000):0; })();
      // Canonical feed speed in m/s. AT reports buses already in km/h but trains/
      // ferries/AM in m/s, so normalise the bus value by /3.6.
      let feedMs=null;
      const rawSpeed=v.vehicle.position.speed;
      if(rawSpeed!==undefined && rawSpeed!==null && isFinite(rawSpeed)){
        feedMs=(isTrain||isFerry||isAM)?Number(rawSpeed):Number(rawSpeed)/3.6;
        if(feedMs<0) feedMs=null;
      }
      const feedBearingDeg=toNum(v.vehicle.position.bearing ?? v.vehicle.position.heading);

      const motion=updateMotion(vehicleId,lat,lon,fixTsMs,feedMs,feedBearingDeg);

      let speedKmh=null, speedStr="N/A";
      if(motion.speedMs!=null){
        speedKmh=motion.speedMs*3.6;
        const srcTag=motion.source==="computed"?" (est.)":"";
        speedStr=isFerry
          ? `${speedKmh.toFixed(1)} km/h (${(motion.speedMs*1.94384).toFixed(1)} kn)${srcTag}`
          : `${speedKmh.toFixed(1)} km/h${srcTag}`;
      }

      let occupancy="N/A";
      const occProto = v.vehicle?.occupancy_status ?? v.vehicle?.occupancyStatus ?? v.vehicle?.occupancy?.status;
      if(occProto!==undefined && occProto!==null){
        if (typeof occProto === "number" && occProto>=0 && occProto<=6) {
          occupancy = occupancyLabels[occProto];
        } else if (typeof occProto === "string") {
          const key = occProto.trim().toUpperCase();
          const map = {
            "EMPTY":0,"MANY_SEATS_AVAILABLE":1,"FEW_SEATS_AVAILABLE":2,"STANDING_ROOM_ONLY":3,"LIMITED_STANDING_ROOM":4,"FULL":5,"NOT_ACCEPTING_PASSENGERS":6
          };
          if (map[key] !== undefined) occupancy = occupancyLabels[map[key]];
        }
      }

      let typeKey="out", color=vehicleColors.out, routeName="Out of service", destination="Unknown";
      if(routeId && tripId && routes[routeId]){
        const r=routes[routeId]; routeName=r.route_short_name||r.route_long_name||"Unknown";
        switch(r.route_type){case 2:typeKey="train";color=trainColorForRoute(r.route_short_name);break; case 3:typeKey="bus";color=vehicleColors.bus;break; case 4:typeKey="ferry";color=vehicleColors.ferry;break;}
      }
      if(routes[routeId]?.route_type===3){typeKey="bus"; color=vehicleColors.bus;}
      if(tripId) allTripIds.push(tripId);

      if(tripId && tripCache[tripId]?.trip_headsign) destination=tripCache[tripId].trip_headsign;
      else if(routes[routeId]) destination=routes[routeId].route_long_name||routes[routeId].route_short_name||"Unknown";

      let bikesLine="";
      const t=tripId?tripCache[tripId]:null;
      if(t?.bikes_allowed!==undefined){
        if(typeKey==="bus" && t.bikes_allowed===2) bikesLine=`<br><b>Bikes allowed:</b> Yes`;
        if(typeKey==="train"){
          if(t.bikes_allowed===2) bikesLine=`<br><b>Bikes allowed:</b> Yes`;
          else if(t.bikes_allowed===1) bikesLine=`<br><b>Bikes allowed:</b> Some`;
        }
      }

      // ---- Optional GTFS-RT extras (rendered only when present) ----
      const pos=v.vehicle.position||{};
      const vp=v.vehicle;
      const ex={};

      // Heading / bearing: use the resolved motion bearing (feed -> derived -> last).
      const headingDeg=(motion && motion.bearingDeg!=null) ? motion.bearingDeg : toNum(pos.bearing ?? pos.heading);
      if(headingDeg!==null){ ex.bearingDeg=((headingDeg%360)+360)%360; ex.heading=bearingToCompass(headingDeg); }

      // Odometer (metres -> km)
      const odo=formatOdometer(pos.odometer);
      if(odo) ex.odometer=odo;

      // Current status + stop reference
      const csRaw=vp.current_status ?? vp.currentStatus;
      const stopRef=vp.stop_id ?? vp.stopId ?? null;
      const stopSeq=toNum(vp.current_stop_sequence ?? vp.currentStopSequence);
      const csNum=toNum(csRaw);
      if(csNum!==null && currentStatusLabels[csNum]!==undefined){
        const where = stopRef ? `stop ${stopRef}` : (stopSeq!==null ? `stop #${stopSeq}` : "");
        ex.statusLine = where ? `${currentStatusLabels[csNum]} ${where}` : currentStatusLabels[csNum];
      }

      // Congestion level (only when meaningful)
      const congNum=toNum(vp.congestion_level ?? vp.congestionLevel);
      if(congNum!==null && congNum>=1 && congestionLabels[congNum]) ex.congestion=congestionLabels[congNum];

      // Trip start time (provided for vehicle positions per AT docs)
      const tripStart=v.vehicle?.trip?.start_time ?? v.vehicle?.trip?.startTime;
      if(tripStart) ex.tripStart=String(tripStart);

      // Age of the position fix
      const fixAge=formatDataAge(vp.timestamp);
      if(fixAge) ex.fixAge=fixAge;

      const extraLines=buildExtraLines(ex);

      let busType = vehicleMarkers[vehicleId]?.busType || "";
      const wasBus   = vehicleMarkers[vehicleId]?.currentType === "bus";
      const isBusNow = typeKey === "bus";
      const needType =
        (isBusNow && !busType) ||
        (isBusNow && !wasBus)  ||
        (!vehicleMarkers[vehicleId] && isBusNow);
      if (needType && operator) {
        const model = getBusType(operator, vehicleNumber);
        if (model) busType = model;
      }

      // Schedule adherence for in-service vehicles (uses the current stop sequence to
      // pick the most relevant delay from the trip update).
      const delaySec=(typeKey!=="out" && tripId) ? delayForTrip(delayMap.get(tripId), stopSeq) : null;
      const scheduleLine=scheduleLineHtml(delaySec);

      if(vehicleLabel.startsWith("AM")){
        if(typeKey==="train") inServiceAM.push({vehicleId,lat,lon,speedKmh,vehicleLabel,color});
        else outOfServiceAM.push({vehicleId,lat,lon,speedKmh,vehicleLabel});
      }

      const badgeText=badgeForRoute(typeKey,routeName);
      addOrUpdateMarker(vehicleId,lat,lon,color,typeKey,tripId,{
        currentType:typeKey,vehicleLabel,licensePlate,busType,speedStr,scheduleLine,occupancy,bikesLine,routeName,destination,extraLines,badgeText
      });

      if(tripId){
        let arr=markersByTrip.get(tripId); if(!arr){ arr=[]; markersByTrip.set(tripId,arr); }
        arr.push(vehicleMarkers[vehicleId]);
      }

      if(vehicleLabel){
        const norm=normalizeFleetLabel(vehicleLabel);
        if(typeKey!=="out") vehicleIndexByFleet.set(norm,vehicleMarkers[vehicleId]);
        else oosIndexByFleet.set(norm,vehicleMarkers[vehicleId]);
      }
      if(routes[routeId]?.route_short_name && typeKey!=="out"){
        const rk=normalizeRouteKey(routes[routeId].route_short_name);
        if(!routeIndex.has(rk)) routeIndex.set(rk,new Set());
        routeIndex.get(rk).add(vehicleMarkers[vehicleId]);
      }

      cachedState.push({vehicleId,lat,lon,color,typeKey,tripId,ts:Date.now(),vehicleLabel,licensePlate,busType,speedStr,scheduleLine,occupancy,bikesLine,routeName,destination,extraLines,badgeText});
    });

    pairAMTrains(inServiceAM,outOfServiceAM);

    Object.keys(vehicleMarkers).forEach(id=>{
      if(!newIds.has(id)){
        if(pinnedPopup===vehicleMarkers[id]){ pinnedPopup=null; pinnedFollow=false; clearRouteOutline(); }
        map.removeLayer(vehicleMarkers[id]); delete vehicleMarkers[id]; motionState.delete(id); activeTweens.delete(id);
      }
    });

    followPinnedIfNeeded(true);

    const nowTs = Date.now();
    saveSnapshot(cachedState);
    setDebug(`Realtime update complete at ${new Date(nowTs).toLocaleTimeString()}`);
    setLastUpdateTs(nowTs);
    lastPollOkTs=nowTs;
    updateVehicleCount();

    await fetchTripsBatch([...new Set(allTripIds)]);

    // Now that shape_ids are known, fetch the shapes we can actually see, and make sure
    // the selected vehicle's outline reflects any shape that just loaded.
    ensureShapesForViewport();
    if(pinnedPopup && pinnedPopup.currentType!=="out") showRouteOutlineFor(pinnedPopup);
  }finally{
    clearTimeout(watchdog);
    vehiclesInFlight=false;
  }
}

function isPageVisible(){ return document.visibilityState !== "hidden"; }

let lastPollOkTs=0;
const STALE_REFRESH_MS=MAX_POLL_MS*2; // visible but no good poll this long => force one

// Self-perpetuating poll loop. It ALWAYS reschedules, so it can never die. The actual
// network call is gated on LIVE visibility (not a cached flag), so it skips work while
// hidden and resumes automatically the moment the page is shown again.
function scheduleNextFetch(){
  if(pollTimeoutId){ clearTimeout(pollTimeoutId); pollTimeoutId=null; }
  const base=basePollDelay();
  const now=Date.now();
  const waitRealtime=backoff.realtime.until>now ? (backoff.realtime.until-now) : 0;
  const delay=Math.max(base, waitRealtime);
  pollTimeoutId=setTimeout(async()=>{
    pollTimeoutId=null;
    try{ if(isPageVisible()) await fetchVehicles(); }
    finally{ scheduleNextFetch(); } // reschedule no matter what happened
  }, delay);
}

// Heartbeat safety net: independently forces a refresh if the page has been visible but
// hasn't had a successful poll for too long. Covers any unexpected stall.
let heartbeatId=null;
function startHeartbeat(){
  if(heartbeatId) return;
  heartbeatId=setInterval(()=>{
    if(!isPageVisible()) return;
    const stale=!lastPollOkTs || (Date.now()-lastPollOkTs)>STALE_REFRESH_MS;
    if(stale && !vehiclesInFlight && backoff.realtime.until<=Date.now()){
      fetchVehicles({ ignoreBackoff:true });
    }
  }, 5000);
}

function pauseUpdatesNow(){
  pageVisible=false;
  vehiclesAbort?.abort?.();            // drop any in-flight request
  setDebug("Paused updates: tab not visible");
  // Intentionally NOT killing the loop; the visibility gate stops fetches while hidden.
}
function schedulePauseAfterHide(){ if(hidePauseTimerId) return; hidePauseTimerId=setTimeout(()=>{ hidePauseTimerId=null; if(document.hidden) pauseUpdatesNow(); },HIDE_PAUSE_DELAY_MS); }
function cancelScheduledPause(){ if(hidePauseTimerId){clearTimeout(hidePauseTimerId); hidePauseTimerId=null;} }
async function resumeUpdatesNow(){
  cancelScheduledPause();
  const wasHidden=!pageVisible;
  pageVisible=true;
  if(!pollTimeoutId) scheduleNextFetch(); // ensure the loop is alive
  startHeartbeat();
  if(wasHidden){
    setDebug("Tab visible. Refreshing...");
    await fetchVehicles({ ignoreBackoff:true }); // immediate catch-up
  }
}

document.addEventListener("visibilitychange",()=>{ if(document.hidden) pauseUpdatesNow(); else resumeUpdatesNow(); });
window.addEventListener("pageshow",()=>{ resumeUpdatesNow(); });
window.addEventListener("pagehide",()=>{ pauseUpdatesNow(); });
window.addEventListener("focus",()=>{ resumeUpdatesNow(); });
window.addEventListener("blur",()=>{ schedulePauseAfterHide(); });

async function init(){
  // Load persisted trips/shapes (and prune expired) before anything fetches, so the first
  // poll's trip/shape lookups hit warm caches instead of the network.
  try{ await idbHydrateAndPrune(); }catch{}

  // Routes: reuse a fresh cached copy and skip /api/routes entirely; otherwise fetch + store.
  let routesReady=false;
  try{
    const rc=await idbGet("routes");
    if(rc && rc.data && (Date.now()-(rc.t||0))<TTL_ROUTES){ routes=rc.data; routesReady=true; }
  }catch{}
  if(!routesReady){
    const rj=await safeFetch(routesUrl); if(rj&&rj._rateLimited) applyRateLimitBackoff(rj.retryAfterMs,"routes");
    if(rj?.data){
      rj.data.forEach(r=>{const a=r.attributes||r; routes[r.id]={route_type:a.route_type,route_short_name:a.route_short_name,route_long_name:a.route_long_name,route_color:a.route_color,agency_id:a.agency_id};});
      idbPutMany([["routes",{t:Date.now(),data:routes}]]);
    }
  }

  const bj=await safeFetch(busTypesUrl);
  if(bj && !bj._rateLimited){ busTypes=bj; busTypeIndex=buildBusTypeIndex(bj); }

  const cached=localStorage.getItem("realtimeSnapshot");
  if(cached){ try{ const snap=JSON.parse(cached); renderFromCache(snap); }catch{} }

  document.querySelectorAll('#filters input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener("change",e=>{
      const layer=e.target.getAttribute("data-layer");
      if(layer==="stops"){ setStopsEnabled(e.target.checked); }
      else if(layer==="rail"){ setRailLinesEnabled(e.target.checked); }
      else if(vehicleLayers[layer]){ if(e.target.checked) map.addLayer(vehicleLayers[layer]); else map.removeLayer(vehicleLayers[layer]); }
      updateControlsHeight();
    });
  });

  // Sync stops toggle to its checkbox state, then load stop geometry.
  const stopsCb=document.querySelector('#filters input[data-layer="stops"]');
  if(stopsCb) stopsEnabled=stopsCb.checked;
  loadStops();

  // Same for the optional rail-line GeoJSON overlay.
  const railCb=document.querySelector('#filters input[data-layer="rail"]');
  if(railCb) railLinesEnabled=railCb.checked;
  loadRailLines();

  updateControlsHeight();

  // Sync the cached flag to reality at startup, then start everything unconditionally.
  pageVisible=isPageVisible();
  startHeartbeat();

  const initialJitter=300+Math.random()*1200;
  setTimeout(async()=>{
    if(isPageVisible()) await fetchVehicles({ ignoreBackoff:true });
    scheduleNextFetch(); // start the self-perpetuating loop regardless of visibility
  }, initialJitter);
}
init();
