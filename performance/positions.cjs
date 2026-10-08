const T=require('../transit-data.js');
const Feed=require('./feed.cjs');
const S=require('../schedule-data.js');
// Papakura bus stop 2716, from the supplied AT stops_bus.csv.
const station={latitude:-37.06495,longitude:174.9463,inner:35,outer:80,archiveRadius:600};
const num=v=>v!=null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
function distance(a,b=station){
  const rad=Math.PI/180,dLat=(b.latitude-a.latitude)*rad,dLon=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.latitude*rad)*Math.cos(b.latitude*rad)*Math.sin(dLon/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(h),Math.sqrt(Math.max(0,1-h)));
}
function extract(feed,routes,metadata,now=Date.now()/1000){
  const header=num(feed?.response?.header?.timestamp??feed?.header?.timestamp);
  if(header==null||now-header>120||header>now+30)throw Error('Vehicle position feed timestamp is stale or missing');
  const route=routes.find(r=>r.active&&r.code==='376'&&r.mode==='bus');if(!route)return [];
  const progress=new Map();
  for(const e of T.entities(feed)){const u=e.trip_update??e.tripUpdate,stamp=num(u?.timestamp);if(!u?.trip?.trip_id||stamp==null||now-stamp>120)continue;
    const stops=T.stopUpdates(u).filter(s=>num(s.stop_sequence)!=null&&[s.arrival?.time,s.departure?.time].some(t=>num(t)!=null&&num(t)<=stamp));
    if(stops.length)progress.set(u.trip.trip_id,{sequence:Math.max(...stops.map(s=>Number(s.stop_sequence))),stamp});}
  const rows=[];
  for(const e of T.entities(feed)){
    const v=e.vehicle,trip=v?.trip;if(e.is_deleted||e.isDeleted||!trip?.trip_id||!Feed.matches(route,trip,metadata.get(trip.route_id)))continue;
    const stamp=num(v.timestamp),latitude=num(v.position?.latitude),longitude=num(v.position?.longitude);
    if(stamp==null||now-stamp>120||stamp>now||latitude==null||longitude==null||Math.abs(latitude)>90||Math.abs(longitude)>180||latitude===0&&longitude===0)continue;
    if([3,'CANCELED','CANCELLED'].includes(trip.schedule_relationship))continue;
    const service_date=String(trip.start_date||'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
    if(!S.validDate(service_date))continue;
    const update=progress.get(trip.trip_id);
    rows.push({route_id:route.id,trip_id:String(trip.trip_id),service_date,start_time:String(trip.start_time||''),vehicle_id:String(v.vehicle?.id||e.id||''),vehicle_label:String(v.vehicle?.label||v.vehicle?.id||e.id||''),position_time:stamp,latitude,longitude,distance:distance({latitude,longitude}),progress_sequence:update&&Math.abs(update.stamp-stamp)<=90?update.sequence:null});
  }
  return rows;
}
const tripKey=r=>JSON.stringify([r.route_id,r.trip_id,r.service_date]);
function visits(schedules,positions){
  const byTrip=new Map(),output=new Map();
  for(const p of positions){const k=tripKey(p);if(!byTrip.has(k))byTrip.set(k,[]);byTrip.get(k).push(p);}
  for(const [k,points] of byTrip){
    const rows=[...new Map(schedules.filter(s=>tripKey(s)===k&&String(s.stop_id).split('-')[0]==='2716').map(s=>[s.sequence,s])).values()].sort((a,b)=>a.sequence-b.sequence);
    if(rows.length!==2||new Set(points.map(p=>p.start_time)).size>1||new Set(points.map(p=>p.vehicle_id)).size>1)continue;
    const ordered=points.sort((a,b)=>a.position_time-b.position_time);
    for(const row of rows){
      const selected=ordered.filter(p=>{const candidates=rows.map(s=>({s,gap:Math.abs(s.scheduled_time-p.position_time)})).sort((a,b)=>a.gap-b.gap);return candidates[0].s.sequence===row.sequence&&candidates[0].gap<=1200&&candidates[1].gap-candidates[0].gap>=60&&(p.progress_sequence==null||p.progress_sequence>=row.sequence-2&&p.progress_sequence<=row.sequence+2);});
      const episodes=[];let group=[];
      for(let i=0;i<selected.length;i++){
        const p=selected[i],prev=selected[i-1];
        if(!prev||p.position_time-prev.position_time>90||p.distance>=station.outer){if(group.length)episodes.push(group);group=[];}
        if(p.distance<station.outer)group.push({p,index:i});
      }if(group.length)episodes.push(group);
      const confirmed=[];
      for(const episode of episodes){
        const inner=episode.filter(x=>x.p.distance<=station.inner),dwells=[];
        for(let i=1;i<inner.length;i++){const a=inner[i-1].p,b=inner[i].p,dt=b.position_time-a.position_time;
          if(dt>=10&&dt<=90&&distance(a,b)<=12)dwells.push(inner[i-1],inner[i]);}
        if(!dwells.length)continue;
        const first=dwells[0],last=dwells[dwells.length-1],before=selected[episode[0].index-1],after=selected[episode[episode.length-1].index+1];
        confirmed.push({arrivalFrom:before?.distance>=station.outer&&first.p.position_time-before.position_time<=90?before.position_time:null,arrivalTo:first.p.position_time,
          departureFrom:last.p.position_time,departureTo:after?.distance>=station.outer&&after.position_time-last.p.position_time<=90?after.position_time:null,
          samples:new Set(dwells.map(d=>d.p.position_time)).size,nearestMetres:Math.round(Math.min(...inner.map(x=>x.p.distance))),vehicleLabel:first.p.vehicle_label,startTime:first.p.start_time});
      }
      if(confirmed.length===1)output.set(JSON.stringify([row.route_id,row.trip_id,row.service_date,'2716',row.sequence]),confirmed[0]);
    }
  }
  return output;
}
module.exports={station,distance,extract,visits};
