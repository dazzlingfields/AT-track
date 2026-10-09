import Schedule from '../../schedule-data.js';

// Public, aggregate arrival measurements only. Never return trip IDs or raw history.
// One network snapshot serves all station selections, limiting D1 reads.
export async function stationAverages(db,now=Date.now()){
  const to=Schedule.dateString(Schedule.parts(now/1000)),from=Schedule.shiftDate(to,-6);
  const sql=`WITH ranked AS (
    SELECT e.*,r.code route_code,r.mode,
      ROW_NUMBER() OVER(PARTITION BY e.route_id,e.trip_id,e.service_date,e.start_time,e.sequence
        ORDER BY e.reported_at DESC,e.event_time DESC,e.stop_id) visit
    FROM events e JOIN routes r ON r.id=e.route_id
    WHERE e.service_date BETWEEN ? AND ? AND e.kind='arrival' AND e.event_time<=?
  ), arrivals AS (
    SELECT *,CASE WHEN instr(stop_id,'-')>0 THEN substr(stop_id,1,instr(stop_id,'-')-1) ELSE stop_id END stop_code
    FROM ranked WHERE visit=1
  ) SELECT stop_code,mode,COUNT(*) observations,COUNT(delay_sec) measured,
    SUM(delay_sec) delayTotal,MAX(event_time) lastObserved,
    GROUP_CONCAT(DISTINCT route_code) routes
    FROM arrivals GROUP BY stop_code,mode ORDER BY stop_code,mode`;
  const {results}=await db.prepare(sql).bind(from,to,now/1000).all();
  return {from,to,kind:'arrival',generatedAt:now/1000,stops:results.map(r=>({...r,
    averageDelay:r.measured?r.delayTotal/r.measured:null,routes:r.routes?r.routes.split(','):[]}))};
}

export async function cachedStationAverages(request,env,ctx,cache=globalThis.caches?.default){
  const key=new Request(new URL('/api/network/station-averages',request.url).href);
  const hit=cache?await cache.match(key):null;if(hit)return hit;
  const response=Response.json(await stationAverages(env.DB),{headers:{
    'Cache-Control':'public, max-age=300, s-maxage=900','X-Content-Type-Options':'nosniff'}});
  if(cache){const task=cache.put(key,response.clone());if(ctx?.waitUntil)ctx.waitUntil(task);else await task;}
  return response;
}
