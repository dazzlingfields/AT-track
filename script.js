//script
const proxyBaseUrl = "https://atrealtime.vercel.app";
const realtimeUrl  = `${proxyBaseUrl}/api/realtime`;
const routesUrl    = `${proxyBaseUrl}/api/routes`;
const tripsUrl     = `${proxyBaseUrl}/api/trips`;
const busTypesUrl  = "busTypes.json";

const light = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",{attribution:"© OpenStreetMap contributors © CARTO",subdomains:"abcd",maxZoom:20});
const dark  = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",{attribution:"© OpenStreetMap contributors © CARTO",subdomains:"abcd",maxZoom:20});
const osm   = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap contributors"});
const satellite  = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Tiles © Esri"});
const esriImagery= L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Tiles © Esri, Maxar, Earthstar Geographics",maxZoom:20});
const esriLabels = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",{attribution:"Labels © Esri",maxZoom:20});
const esriHybrid = L.layerGroup([esriImagery, esriLabels]);

const map = L.map("map",{center:[-36.8485,174.7633],zoom:12,layers:[light],zoomControl:false});
const baseMaps = {"Light":light,"Dark":dark,"OSM":osm,"Satellite":satellite,"Esri Hybrid":esriHybrid};
L.control.layers(baseMaps,null).addTo(map);

const vehicleLayers={bus:L.layerGroup().addTo(map),train:L.layerGroup().addTo(map),ferry:L.layerGroup().addTo(map),out:L.layerGroup().addTo(map)};

const vehicleMarkers={};              
const tripCache={};                   
let routes={}, busTypes={}, busTypeIndex={};
const vehicleIndexByFleet=new Map();  
const routeIndex=new Map();         
const oosIndexByFleet=new Map();
const debugBox=document.getElementById("debug");
const mobileUpdateEl=document.getElementById("mobile-last-update");

let pinnedPopup=null;           
let pinnedFollow=false;            

map.on("click",()=>{
  if(pinnedPopup){ pinnedPopup.closePopup(); pinnedPopup=null; pinnedFollow=false; }
  clearRouteHighlights();
});


map.on("dragstart", ()=> { pinnedFollow=false; });
map.on("popupclose", ()=> { pinnedFollow=false; });

const vehicleColors={bus:"#4a90e2",train:"#d0021b",ferry:"#1abc9c",out:"#9b9b9b"};
const trainLineColors={STH:"#d0021b",WEST:"#7fbf6a",EAST:"#f8e71c",ONE:"#0e76a8"};
const occupancyLabels=["Empty","Many seats available","Few seats available","Standing only","Limited standing","Full","Not accepting passengers"];


const MIN_POLL_MS=15000, MAX_POLL_MS=27000;
function basePollDelay(){return MIN_POLL_MS+Math.floor(Math.random()*(MAX_POLL_MS-MIN_POLL_MS+1));}


const BACKOFF_START_MS=15000, BACKOFF_MAX_MS=120000;
const backoff = {
  realtime: { ms:0, until:0 },
  routes:   { ms:0, until:0 },
  trips:    { ms:0, until:0 },
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

function parseRetryAfterMs(v){ if(!v) return 0; const s=Number(v); if(!isNaN(s)) return Math.max(0,Math.floor(s*1000)); const t=Date.parse(v); return isNaN(t)?0:Math.max(0,t-Date.now()); }
async function safeFetch(url,opts={}){
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

function buildPopup(routeName,destination,vehicleLabel,busType,licensePlate,speedStr,occupancy,bikesLine,extraLines){
  return `<div style="font-size:0.9em;line-height:1.3;">
      <b>Route:</b> ${routeName}<br>
      <b>Destination:</b> ${destination}<br>
      <b>Vehicle:</b> ${vehicleLabel}<br>
      ${busType?`<b>Bus model:</b> ${busType}<br>`:""}
      <b>Number plate:</b> ${licensePlate}<br>
      <b>Speed:</b> ${speedStr}<br>
      <b>Occupancy:</b> ${occupancy}
      ${bikesLine||""}
      ${extraLines||""}
    </div>`;
}

// ===================== Motion / speed estimation + dead reckoning ====================
// Two goals, both achieved WITHOUT any extra API calls (they reuse the existing poll):
//  1. Better speed. AT's position.speed is often missing, zeroed-while-moving, or
//     stale. We instead derive ground speed from successive GTFS-RT fixes
//     (great-circle distance / Δt using each vehicle's own timestamp), smooth it with
//     an EMA, and fall back to the feed value only when a fix-to-fix value cannot be
//     computed (e.g. first sighting).
//  2. Smoother tracking. Between the 15-27 s polls each moving marker is projected
//     forward along its velocity vector (dead reckoning) on a throttled rAF loop, so
//     motion looks continuous at the same poll cadence. On the next real poll the
//     marker snaps back to ground truth.
const R_EARTH = 6371000;
const prefersReducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

const motionState = new Map(); // vehicleId -> motion record (persists across polls)

// Tuning knobs
const SPEED_EMA_ALPHA      = 0.4;    // displayed-speed smoothing (0..1, higher = snappier)
const DERIVE_MIN_DT_MS     = 2000;   // ignore fix gaps shorter than this (too noisy)
const DERIVE_MAX_DT_MS     = 90000;  // gaps longer than this => treat as a fresh anchor
const DERIVE_MAX_SPEED_MS  = 70;     // ~252 km/h; reject GPS glitches above this
const DR_MIN_SPEED_MS      = 1.0;    // don't project below ~3.6 km/h (avoids jitter)
const DR_MAX_PROJECT_MS    = 30000;  // stop projecting >30 s past the last fix
const DR_MIN_BEARING_DISP_M= 5;      // need >5 m of travel to trust a derived bearing
const DR_FRAME_MS          = 120;    // ~8 fps projection cadence (battery friendly)

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
// Project a point forward (flat-earth approx; error is negligible under ~2 km).
function projectLatLon(lat,lon,bearingDeg,distM){
  const t=toRad(bearingDeg);
  const dLat=(distM*Math.cos(t))/R_EARTH;
  const dLon=(distM*Math.sin(t))/(R_EARTH*Math.cos(toRad(lat)));
  return [lat+toDeg(dLat), lon+toDeg(dLon)];
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

  // Bearing for projection + heading display: derived -> feed -> previous.
  let bearingDeg=null;
  if(derivedBearing!=null) bearingDeg=derivedBearing;
  else if(feedBearingDeg!=null) bearingDeg=((feedBearingDeg%360)+360)%360;
  else if(prev && prev.bearingDeg!=null) bearingDeg=prev.bearingDeg;

  // Only dead-reckon vehicles that are genuinely moving, have a heading, are getting
  // fresh fixes, and when the user hasn't asked to reduce motion.
  const hasVel=(speedMs!=null && speedMs>=DR_MIN_SPEED_MS && bearingDeg!=null && !staleFix && !prefersReducedMotion);

  motionState.set(id,{
    fixLat:lat, fixLon:lon, fixTs:effFixTs,
    trueLat:lat, trueLon:lon, anchorClientMs:nowClient,
    speedMs, bearingDeg, source, hasVel
  });

  return {speedMs, bearingDeg, source};
}

// Keep the followed vehicle roughly centred. Called from the rAF loop (animate=false
// for per-frame nudges) and once per poll (animate=true).
function followPinnedIfNeeded(animate){
  if(!(pinnedPopup && pinnedFollow)) return;
  try{
    const ll=pinnedPopup.getLatLng();
    const c=map.latLngToLayerPoint(map.getCenter());
    const p=map.latLngToLayerPoint(ll);
    if(Math.abs(c.x-p.x)>6 || Math.abs(c.y-p.y)>6) map.panTo(ll,{animate});
  }catch{}
}

// Throttled dead-reckoning render loop.
let _drLast=0;
function deadReckonTick(ts){
  requestAnimationFrame(deadReckonTick);
  if(!pageVisible || prefersReducedMotion) return;
  if(ts-_drLast<DR_FRAME_MS) return;
  _drLast=ts;
  const now=Date.now();
  motionState.forEach((st,id)=>{
    if(!st.hasVel) return;
    const m=vehicleMarkers[id]; if(!m) return;
    let elapsed=now-st.anchorClientMs;
    if(elapsed<=0) return;
    if(elapsed>DR_MAX_PROJECT_MS) elapsed=DR_MAX_PROJECT_MS;
    const dist=st.speedMs*(elapsed/1000);
    const [plat,plon]=projectLatLon(st.trueLat,st.trueLon,st.bearingDeg,dist);
    m.setLatLng([plat,plon]);
  });
  followPinnedIfNeeded(false);
}
if(!prefersReducedMotion) requestAnimationFrame(deadReckonTick);

function addOrUpdateMarker(id,lat,lon,popupContent,color,type,tripId,fields={}){
  const isMobile=window.innerWidth<=600;
  const baseRadius=isMobile?6:5;
  const popupOpts={maxWidth:isMobile?220:260,className:"vehicle-popup"};

  if(vehicleMarkers[id]){
    const m=vehicleMarkers[id];
    m.setLatLng([lat,lon]);
    m.setPopupContent(popupContent);
    m.setStyle({fillColor:color});
    m.tripId=tripId;
    if(m._baseRadius==null) m._baseRadius=baseRadius;
    Object.assign(m,fields);

    Object.values(vehicleLayers).forEach(l=>l.removeLayer(m));
    (vehicleLayers[type]||vehicleLayers.out).addLayer(m);
  }else{
    const marker=L.circleMarker([lat,lon],{radius:baseRadius,fillColor:color,color:"#000",weight:1,opacity:1,fillOpacity:0.9});
    marker._baseRadius=baseRadius;
    (vehicleLayers[type]||vehicleLayers.out).addLayer(marker);
    marker.bindPopup(popupContent,popupOpts);

    if(!marker._eventsBound){
      marker.on("mouseover",function(){ if(pinnedPopup!==this) this.openPopup(); });
      marker.on("mouseout", function(){ if(pinnedPopup!==this) this.closePopup(); });
      marker.on("click",    function(e){
        if(pinnedPopup&&pinnedPopup!==this) pinnedPopup.closePopup();
        pinnedPopup=this; pinnedFollow=true;
        this.openPopup();
        e?.originalEvent?.stopPropagation?.();
      });
      marker._eventsBound=true;
    }

    marker.tripId=tripId;
    Object.assign(marker,fields);
    vehicleMarkers[id]=marker;
  }
}
function updateVehicleCount(){
  const busCount=Object.values(vehicleMarkers).filter(m=>vehicleLayers.bus.hasLayer(m)).length;
  const trainCount=Object.values(vehicleMarkers).filter(m=>vehicleLayers.train.hasLayer(m)).length;
  const ferryCount=Object.values(vehicleMarkers).filter(m=>vehicleLayers.ferry.hasLayer(m)).length;
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
      if (!opts.preservePopup && pinnedPopup) { pinnedPopup.closePopup(); pinnedPopup = null; pinnedFollow=false; }
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
      tripJson.data.forEach(t=>{
        const a=t.attributes;
        if(a){ tripCache[a.trip_id]={trip_id:a.trip_id,trip_headsign:a.trip_headsign||"N/A",route_id:a.route_id,bikes_allowed:a.bikes_allowed}; }
      });
  
      ids.forEach(tid=>{
        const trip=tripCache[tid]; if(!trip) return;
        Object.values(vehicleMarkers).forEach(m=>{
          if(m.tripId===tid){
            const r=routes[trip.route_id]||{};
            const base=buildPopup(r.route_short_name||r.route_long_name||"Unknown",trip.trip_headsign||r.route_long_name||"Unknown",m.vehicleLabel||"N/A",m.busType||"",m.licensePlate||"N/A",m.speedStr||"",m.occupancy||"",m.bikesLine||"");
            const pair=m.pairedTo?`<br><b>Paired to:</b> ${m.pairedTo} (6-car)`:``;
            m.setPopupContent(base+pair);
          }
        });
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
    if(outM){ outM.setStyle({fillColor:inColor}); const c=outM.getPopup()?.getContent()||""; outM.getPopup().setContent(c+`<br><b>Paired to:</b> ${p.inTrain.vehicleLabel} (6-car)`); outM.pairedTo=p.inTrain.vehicleLabel; }
    if(inM) inM.pairedTo=p.outTrain.vehicleLabel;
  });
  return pairs;
}

function renderFromCache(c){
  if(!c) return;
  c.forEach(v=>addOrUpdateMarker(v.vehicleId,v.lat,v.lon,v.popupContent,v.color,v.typeKey,v.tripId,{
    currentType:v.typeKey,vehicleLabel:v.vehicleLabel||"",licensePlate:v.licensePlate||"",busType:v.busType||"",speedStr:v.speedStr||"",occupancy:v.occupancy||"",bikesLine:v.bikesLine||""
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
  if(!pageVisible || vehiclesInFlight || realtimeBlocked) return;
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
    vehicleIndexByFleet.clear(); routeIndex.clear(); oosIndexByFleet.clear();

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

      const popup=buildPopup(routeName,destination,vehicleLabel,busType,licensePlate,speedStr,occupancy,bikesLine,extraLines);

      if(vehicleLabel.startsWith("AM")){
        if(typeKey==="train") inServiceAM.push({vehicleId,lat,lon,speedKmh,vehicleLabel,color});
        else outOfServiceAM.push({vehicleId,lat,lon,speedKmh,vehicleLabel});
      }

      addOrUpdateMarker(vehicleId,lat,lon,popup,color,typeKey,tripId,{
        currentType:typeKey,vehicleLabel,licensePlate,busType,speedStr,occupancy,bikesLine
      });

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

      cachedState.push({vehicleId,lat,lon,popupContent:popup,color,typeKey,tripId,ts:Date.now(),vehicleLabel,licensePlate,busType,speedStr,occupancy,bikesLine});
    });

    pairAMTrains(inServiceAM,outOfServiceAM);

    Object.keys(vehicleMarkers).forEach(id=>{
      if(!newIds.has(id)){
        if(pinnedPopup===vehicleMarkers[id]){ pinnedPopup=null; pinnedFollow=false; }
        map.removeLayer(vehicleMarkers[id]); delete vehicleMarkers[id]; motionState.delete(id);
      }
    });

    followPinnedIfNeeded(true);

    const nowTs = Date.now();
    localStorage.setItem("realtimeSnapshot",JSON.stringify(cachedState));
    setDebug(`Realtime update complete at ${new Date(nowTs).toLocaleTimeString()}`);
    setLastUpdateTs(nowTs);
    updateVehicleCount();

    await fetchTripsBatch([...new Set(allTripIds)]);
  }finally{
    clearTimeout(watchdog);
    vehiclesInFlight=false;
  }
}

function scheduleNextFetch(){
  if(pollTimeoutId){ clearTimeout(pollTimeoutId); pollTimeoutId=null; }
  if(!pageVisible) return;
  const base = basePollDelay();
  const now = Date.now();
  const waitRealtime = backoff.realtime.until > now ? (backoff.realtime.until - now) : 0;
  const delay = Math.max(base, waitRealtime);
  pollTimeoutId=setTimeout(async()=>{ if(!pageVisible) return; await fetchVehicles(); scheduleNextFetch(); },delay);
}
function pauseUpdatesNow(){ pageVisible=false; if(pollTimeoutId){clearTimeout(pollTimeoutId); pollTimeoutId=null;} vehiclesAbort?.abort?.(); setDebug("Paused updates: tab not visible"); }
function schedulePauseAfterHide(){ if(hidePauseTimerId) return; hidePauseTimerId=setTimeout(()=>{ hidePauseTimerId=null; if(document.hidden) pauseUpdatesNow(); },HIDE_PAUSE_DELAY_MS); }
function cancelScheduledPause(){ if(hidePauseTimerId){clearTimeout(hidePauseTimerId); hidePauseTimerId=null;} }
async function resumeUpdatesNow(){
  cancelScheduledPause();
  const wasHidden=!pageVisible;
  pageVisible=true;
  if(wasHidden){
    setDebug("Tab visible. Refreshing...");
    await fetchVehicles({ ignoreBackoff: true });
  }
  scheduleNextFetch();
}

document.addEventListener("visibilitychange",()=>{ if(document.hidden) pauseUpdatesNow(); else resumeUpdatesNow(); });
window.addEventListener("pageshow",()=>{ resumeUpdatesNow(); });
window.addEventListener("pagehide",()=>{ pauseUpdatesNow(); });
window.addEventListener("focus",()=>{ resumeUpdatesNow(); });
window.addEventListener("blur",()=>{ schedulePauseAfterHide(); });

async function init(){
  const rj=await safeFetch(routesUrl); if(rj&&rj._rateLimited) applyRateLimitBackoff(rj.retryAfterMs,"routes");
  if(rj?.data){ rj.data.forEach(r=>{const a=r.attributes||r; routes[r.id]={route_type:a.route_type,route_short_name:a.route_short_name,route_long_name:a.route_long_name,route_color:a.route_color,agency_id:a.agency_id};}); }

  const bj=await safeFetch(busTypesUrl);
  if(bj && !bj._rateLimited){ busTypes=bj; busTypeIndex=buildBusTypeIndex(bj); }

  const cached=localStorage.getItem("realtimeSnapshot");
  if(cached){ try{ const snap=JSON.parse(cached); renderFromCache(snap); }catch{} }

  document.querySelectorAll('#filters input[type="checkbox"]').forEach(cb=>{
    cb.addEventListener("change",e=>{
      const layer=e.target.getAttribute("data-layer");
      if(vehicleLayers[layer]){ if(e.target.checked) map.addLayer(vehicleLayers[layer]); else map.removeLayer(vehicleLayers[layer]); }
      updateControlsHeight();
    });
  });

  updateControlsHeight();

  const initialJitter = 500 + Math.random()*2500;
  setTimeout(async () => {
    await fetchVehicles({ ignoreBackoff: true });
    scheduleNextFetch();
  }, initialJitter);
}
init();
