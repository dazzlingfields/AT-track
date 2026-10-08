const T=require('../transit-data.js'),Feed=require('./feed.cjs'),S=require('../schedule-data.js'),Search=require('./search.cjs');
const labels=['Empty','Many seats available','Few seats available','Standing room only','Limited standing space','Full','Not accepting passengers','No data','Not boardable'];
const enums=['EMPTY','MANY_SEATS_AVAILABLE','FEW_SEATS_AVAILABLE','STANDING_ROOM_ONLY','CRUSHED_STANDING_ROOM_ONLY','FULL','NOT_ACCEPTING_PASSENGERS','NO_DATA_AVAILABLE','NOT_BOARDABLE'];
const num=v=>v!=null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
function extract(feed,routes,metadata,now=Date.now()/1000){
 const header=num(feed?.response?.header?.timestamp??feed?.header?.timestamp);if(header==null||now-header>120||header>now+30)throw Error('Occupancy feed is stale');
 const output=[],matches=new Map();
 for(const e of T.entities(feed)){const v=e.vehicle,trip=v?.trip;if(e.is_deleted||!trip?.trip_id)continue;
  if(!matches.has(trip.route_id))matches.set(trip.route_id,routes.find(r=>r.active&&Feed.matches(r,trip,metadata.get(trip.route_id)))||null);const route=matches.get(trip.route_id);if(!route)continue;
  const stamp=num(v.timestamp),date=String(trip.start_date||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');if(stamp==null||now-stamp>120||stamp>now||!S.validDate(date)||[3,'CANCELED','CANCELLED'].includes(trip.schedule_relationship))continue;
  const raw=v.occupancy_status??v.occupancyStatus,status=typeof raw==='string'&&enums.includes(raw)?enums.indexOf(raw):num(raw),percentage=num(v.occupancy_percentage??v.occupancyPercentage);
  output.push({route_id:route.id,trip_id:String(trip.trip_id),service_date:date,start_time:String(trip.start_time||''),vehicle_id:String(v.vehicle?.id||e.id||''),sample_bucket:Math.floor(stamp/300),sample_time:stamp,occupancy_status:Number.isInteger(status)&&status>=0&&status<=8?status:null,occupancy_percentage:percentage!=null&&percentage>=0?percentage:null});
 }return output;
}
function queries(filters){
 const {where,params}=Search.eventSql({...filters,kind:'occupancy'});
 const cte=`WITH readings AS(SELECT *,sample_time AS event_time,vehicle_id AS stop_id,'occupancy' AS kind FROM occupancy_samples),matched AS(SELECT * FROM readings WHERE ${where}) `;
 return [{sql:cte+'SELECT route_id,service_date,occupancy_status,COUNT(*) AS samples FROM matched GROUP BY route_id,service_date,occupancy_status',params},
  {sql:cte+'SELECT route_id,service_date,trip_id,start_time,AVG(occupancy_percentage) AS percentage FROM matched GROUP BY route_id,service_date,trip_id,start_time',params}];
}
function report(groups,trips,routes,filters){
 const summarize=(rows,instances)=>{
  const counts=Array(9).fill(0);let unknown=0;for(const r of rows){if(r.occupancy_status==null||r.occupancy_status===7)unknown+=r.samples;else counts[r.occupancy_status]+=r.samples;}
  const measured=counts.slice(0,6).reduce((a,b)=>a+b,0),percentages=instances.map(r=>r.percentage).filter(p=>p!=null);
  const highest=Math.max(...counts.slice(0,6)),typical=highest?counts.slice(0,6).map((n,i)=>n===highest?labels[i]:null).filter(Boolean).join(' / '):'No measured load category';
  return {samples:rows.reduce((n,r)=>n+r.samples,0),trips:instances.length,unknown,measured,typical,averagePercentage:percentages.length?percentages.reduce((a,b)=>a+b,0)/percentages.length:null,percentageTrips:percentages.length,
   distribution:counts.map((count,status)=>({status,label:labels[status],count})).filter(r=>r.count),standingOrFullPercent:measured?100*counts.slice(3,6).reduce((a,b)=>a+b,0)/measured:null,notBoarding:counts[6]+counts[8]};
 };
 return {from:filters.from,to:filters.to,routes:routes.filter(r=>!filters.routeId||r.id===filters.routeId).map(r=>({...r,...summarize(groups.filter(g=>g.route_id===r.id),trips.filter(t=>t.route_id===r.id))})),
 daily:[...new Set(groups.map(g=>g.service_date))].sort().reverse().flatMap(date=>routes.filter(r=>(!filters.routeId||r.id===filters.routeId)&&groups.some(g=>g.route_id===r.id&&g.service_date===date)).map(r=>({date,route_id:r.id,code:r.code,...summarize(groups.filter(g=>g.route_id===r.id&&g.service_date===date),trips.filter(t=>t.route_id===r.id&&t.service_date===date))})))};
}
module.exports={extract,queries,report,labels};
