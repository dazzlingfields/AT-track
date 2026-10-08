const code=id=>String(id??'').replace(/-[a-f\d]{6,}$/i,'');
function estimate(station,kind,events,predictions,now){
 const same=r=>r.route_id===station.route_id&&r.trip_id===station.trip_id&&r.service_date===station.service_date;
 const nearby=events.filter(r=>same(r)&&Math.abs(r.sequence-station.sequence)<=2&&Math.abs(r.event_time-station.scheduled_time)<=1800&&r.event_time<=now);
 const remembered=predictions.filter(r=>same(r)&&code(r.stop_id)===code(station.stop_id)&&r.sequence===station.sequence&&r.kind===kind);
 const starts=new Set([...nearby,...remembered].map(r=>r.start_time||'').filter(Boolean));if(starts.size>1||remembered.some(r=>r.invalid))return null;
 const direct=nearby.find(r=>r.sequence===station.sequence&&code(r.stop_id)===code(station.stop_id)&&r.kind===kind);if(direct)return null;
 const before=nearby.filter(r=>r.sequence<station.sequence).sort((a,b)=>b.event_time-a.event_time)[0];
 const after=nearby.filter(r=>r.sequence>station.sequence).sort((a,b)=>a.event_time-b.event_time)[0];
 const at=nearby.filter(r=>r.sequence===station.sequence&&code(r.stop_id)===code(station.stop_id));
 let low=before?.event_time??null,high=after?.event_time??null;
 if(kind==='arrival'){const departure=at.find(r=>r.kind==='departure');if(departure)high=Math.min(high??Infinity,departure.event_time);}
 else {const arrival=at.find(r=>r.kind==='arrival');if(arrival)low=Math.max(low??-Infinity,arrival.event_time);}
 const prediction=remembered.filter(r=>r.passed_at!=null&&r.passed_at<=now&&r.event_time<=r.passed_at).sort((a,b)=>b.reported_at-a.reported_at)[0];
 let time,delta,source,uncertainty;
 if(prediction){time=prediction.event_time;delta=prediction.delay_sec;source='station prediction confirmed by later stop progress';uncertainty=Math.max(60,prediction.uncertainty||0);high=Math.min(high??Infinity,prediction.passed_at);}
 else {
  // A current delay alone cannot establish a completed station visit.
  if(!after)return null;
  const delays=nearby.filter(r=>r.delay_sec!=null&&r.sequence!==station.sequence).sort((a,b)=>Math.abs(a.sequence-station.sequence)-Math.abs(b.sequence-station.sequence)||b.event_time-a.event_time);
  if(!delays.length)return null;
  delta=delays[0].delay_sec;time=station.scheduled_time+delta;source='nearby stop delay projected onto station timetable';
  uncertainty=Math.max(60,...delays.slice(0,2).map(r=>Math.abs(r.delay_sec-delta)));
 }
 low=Math.max(low??-Infinity,time-uncertainty);high=Math.min(high??Infinity,time+uncertainty);
 if(!Number.isFinite(low)||!Number.isFinite(high)||low>high||high>now)return null;
 return {time:Math.min(high,Math.max(low,time)),earliest:low,latest:high,delay:delta,source,uncertaintySeconds:uncertainty,sequenceBefore:before?.sequence??null,sequenceAfter:after?.sequence??null,timetableBasis:prediction?'station prediction':'station departure timetable'};
}
module.exports={estimate};
