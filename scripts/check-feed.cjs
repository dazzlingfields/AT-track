// Read-only diagnostics; uses the existing public proxy and never needs an API key.
// Usage: node scripts/check-feed.cjs [https://your-proxy.example/api/]
const fs=require('node:fs');
const path=require('node:path');
const T=require('../transit-data.js');
const base=new URL(process.argv[2]||'https://atrealtime.vercel.app/api/');
if(!['http:','https:'].includes(base.protocol)) throw Error('Use an HTTP(S) API URL');
if(!base.pathname.endsWith('/')) base.pathname+='/';
async function read(endpoint){
  const response=await fetch(new URL(endpoint,base),{signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw Error(`${endpoint}: HTTP ${response.status}`);
  return response.json();
}
(async()=>{
  const [feed,routeFeed]=await Promise.all([read('realtime'),read('routes')]);
  const routes=new Map((routeFeed.data||[]).map(r=>[r.id??r.attributes?.route_id,r.attributes||r]));
  const railIds=new Set([...routes].filter(([,r])=>Number(r.route_type)===2).map(([id])=>id));
  const exact=new Map();
  const stations=JSON.parse(fs.readFileSync(path.join(__dirname,'../train_stations.geojson'),'utf8'));
  for(const f of stations.features){
    exact.set(f.properties.PARENTSTATION,f.properties.STOPNAME);
    for(const p of f.properties.platforms) exact.set(p.id,f.properties.STOPNAME);
  }
  const aliases=T.stopAliases(exact),entries=T.entities(feed),updates=new Map();
  for(const e of entries){
    const u=e.trip_update??e.tripUpdate;
    if(u && railIds.has(u.trip?.route_id??u.trip?.routeId)) updates.set(u.trip.trip_id??u.trip.tripId,u);
  }
  const now=Date.now()/1000,result=T.buildArrivals(updates,{now,
    resolveStop:id=>T.resolveStop(id,exact,aliases),serviceForTrip:()=>({})});
  const timestamp=Number(feed.response?.header?.timestamp??feed.header?.timestamp);
  console.log(JSON.stringify({api:base.origin,feedAgeSeconds:Number.isFinite(timestamp)?Math.round(now-timestamp):null,
    entities:entries.length,railVehicles:entries.filter(e=>railIds.has(e.vehicle?.trip?.route_id??e.vehicle?.trip?.routeId)).length,
    railUpdates:updates.size,objectStopUpdates:[...updates.values()].filter(u=>!Array.isArray(u.stop_time_update??u.stopTimeUpdate)).length,
    arrivals:result.stats,stationsWithReportedTimes:result.byStop.size,
    note:'A recent-stop report is not a full station departure forecast.'},null,2));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
