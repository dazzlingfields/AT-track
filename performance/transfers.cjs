const names=require('./stop-names.json');
const S=require('../schedule-data.js');
const Search=require('./search.cjs');
const Positions=require('./positions.cjs');
const Evidence=require('./station-evidence.cjs');
const Hours=require('./hours.cjs');
const stopCode=id=>String(id??'').replace(/-[a-f\d]{6,}$/i,'');
const stopName=id=>names[stopCode(id)]||String(id);
const stationCodes=['2716','2554','9228','9229','9230'];
const timetableIds=['2716-29bbacfe','9228-ba7409d9','9229-e27fe938','9230-b7b695a0'];
const key=r=>JSON.stringify([r.route_id,r.trip_id,r.service_date,stopCode(r.stop_id),r.sequence]);
const tripKey=r=>JSON.stringify([r.route_id,r.trip_id,r.service_date]);
function scheduleRows(payload,routes,now=Date.now()/1000){
  const output=[];
  for(const row of payload?.data||[]){
    const route=routes.find(r=>r.active&&((r.code==='376'&&/^376(?:-|$)/.test(row.routeId))||(r.code==='S-C'&&/^S-C(?:-|$)/.test(row.routeId))));
    if(!route||!stationCodes.includes(stopCode(row.stopId))||!S.validDate(row.serviceDate)||!Number.isFinite(Number(row.sequence))||!Number.isFinite(row.scheduledTime))continue;
    output.push({route_id:route.id,trip_id:row.tripId,service_date:row.serviceDate,stop_id:row.stopId,
      stop_code:stopCode(row.stopId),sequence:Number(row.sequence),scheduled_time:row.scheduledTime,destination:String(row.destination||''),pickup_type:Number(row.pickupType??0),seen_at:now});
  }
  return output;
}
function transferOptions(url){
  const walk=Number(url.searchParams.get('walk')??120),direction=url.searchParams.get('direction')||'city',connection=url.searchParams.get('connection')||'bus-train',window=Number(url.searchParams.get('window')??600);
  if(!Number.isFinite(walk)||walk<60||walk>1800||!['city','both'].includes(direction))throw Error('Choose a transfer walk of 1–30 minutes and a valid train direction');
  const transferSearch=String(url.searchParams.get('transferSearch')||'').trim(),transferFrom=url.searchParams.get('transferFrom')||'',transferTo=url.searchParams.get('transferTo')||'',result=url.searchParams.get('result')||'all';
  Search.searchOptions(new URLSearchParams({q:transferSearch,timeFrom:transferFrom,timeTo:transferTo}));
  if(!['all','possible','missed','unknown','pending','cancelled','estimated-possible','estimated-missed','estimated-uncertain'].includes(result))throw Error('Choose a valid transfer result');
  if(!['bus-train','train-bus'].includes(connection))throw Error('Choose a valid connection direction');
  if(!Number.isFinite(window)||window<60||window>3600)throw Error('Choose a train-to-bus window of 1–60 minutes');
  return {walk,direction,connection,window,transferSearch,transferFrom,transferTo,result};
}
function bounds(from,to){
  if(Date.parse(to)-Date.parse(from)>30*86400000)throw Error('Transfer history supports up to 31 days; choose a shorter range');
  return {from:S.shiftDate(from,-1),to:S.shiftDate(to,1)};
}
function analyze(schedules,events,cancellations,routes,{from,to,walk=120,direction='city',connection='bus-train',window=600,positions=[],predictions=[],now=Date.now()/1000,transferSearch='',transferFrom='',transferTo='',result='all'}){
  const busId=routes.find(r=>r.code==='376'&&r.mode==='bus')?.id,trainId=routes.find(r=>r.code==='S-C'&&r.mode==='train')?.id;
  const observations=new Map(),cancelled=new Set(cancellations.map(tripKey));
  for(const e of events){const k=key(e);if(!observations.has(k))observations.set(k,{});const slot=observations.get(k);
    slot.startTimes??=new Set();slot.startTimes.add(String(e.start_time??''));if(slot.startTimes.size>1)slot.ambiguous=true;
    if(!slot[e.kind]||e.reported_at>slot[e.kind].reported_at)slot[e.kind]=e;
  }
  const busTrips=new Map();
  for(const r of schedules.filter(r=>r.route_id===busId)){
    const k=tripKey(r);if(!busTrips.has(k))busTrips.set(k,[]);busTrips.get(k).push(r);
  }
  const city=r=>/city|waitemat|britomart|te waihorotiu/i.test(r.destination);
  const trains=schedules.filter(r=>r.route_id===trainId&&r.pickup_type!==1&&(direction==='both'||city(r))).sort((a,b)=>a.scheduled_time-b.scheduled_time);
  const returns=[],firstVisits=[],unclassified=[];
  for(const rows of busTrips.values()){
    const visits=[...new Map(rows.map(r=>[r.sequence,r])).values()].sort((a,b)=>a.sequence-b.sequence);
    if(visits.length<2){unclassified.push(...visits.filter(r=>r.scheduled_time<=now&&r.service_date>=from&&r.service_date<=to));continue;}
    // Exactly the second distinct scheduled station visit, never the latest poll.
    returns.push(visits[1]);firstVisits.push(visits[0]);
  }
  const lowerBound=time=>{let lo=0,hi=trains.length;while(lo<hi){const mid=(lo+hi)>>1;if(trains[mid].scheduled_time<time)lo=mid+1;else hi=mid;}return lo;};
  const pairs=[];
  const gps=Positions.visits(schedules,positions);
  function timingEstimates(pair,bus,train,observed,trainObserved){
    if(observed.ambiguous||trainObserved.ambiguous)return;
    const kind=connection==='bus-train'?'arrival':'departure',trainKind=connection==='bus-train'?'departure':'arrival';
    pair.busEstimate=Evidence.estimate(bus,kind,events,predictions,now);pair.trainEstimate=Evidence.estimate(train,trainKind,events,predictions,now);
    if(pair.status!=='unknown')return;
    if(!pair.busEstimate&&!pair.trainEstimate)return;
    const exactBus=observed[kind],exactTrain=trainObserved[trainKind],g=pair.busLocation;
    let b=exactBus?{earliest:exactBus.event_time,latest:exactBus.event_time}:pair.busEstimate;
    if(!b&&g)b=kind==='arrival'?{earliest:g.arrivalFrom,latest:g.arrivalTo}:g.departureTo==null?null:{earliest:g.departureFrom,latest:g.departureTo};
    const t=exactTrain?{earliest:exactTrain.event_time,latest:exactTrain.event_time}:pair.trainEstimate;
    if(!b||!t)return;
    const low=connection==='bus-train'?t.earliest-b.latest:b.earliest-t.latest,high=connection==='bus-train'?b.earliest==null?null:t.latest-b.earliest:b.latest-t.earliest;
    if(!Number.isFinite(low)||high!==null&&!Number.isFinite(high))return;
    pair.estimatedGapFrom=low;pair.estimatedGapTo=high;pair.evidence='progress';
    const possible=low>=walk&&(connection==='bus-train'||high!=null&&high<=window),missed=high!=null&&high<walk||connection==='train-bus'&&low>window;
    pair.status=possible?'estimated-possible':missed?'estimated-missed':'estimated-uncertain';
    pair.reason=possible?'Stop-progress timing estimates allow the walk':missed?'Stop-progress timing estimates fall outside the connection limits':'Estimated timing range overlaps the connection limit; exact station times are missing';
  }
  function pending(pair){if(pair.status!=='unknown')return;const waiting=connection==='bus-train'?pair.scheduledTrain:pair.scheduledBus;if(waiting!=null&&waiting+120>=now){pair.status='pending';pair.reason=connection==='bus-train'?'Waiting for intended train departure evidence':'Waiting for intended bus departure evidence';}}
  function timetableFallback(pair,bus,train){
    // Require a reported station departure to establish that the bus actually visited.
    // This is an opportunity against the timetable, not proof of the train's actual departure.
    if(connection!=='bus-train'||bus.ambiguous||train.ambiguous||train.arrival||train.departure||!bus.departure)return;
    const arrival=bus.arrival?.event_time??bus.departure.event_time;
    if(arrival>bus.departure.event_time)return;
    const gap=pair.scheduledTrain-arrival;
    pair.timetableGap=gap;pair.timetableMargin=gap-walk;
    pair.timetableUsesDeparture=!bus.arrival;pair.evidence='timetable';
    pair.status=gap>=walk?'estimated-possible':'estimated-missed';
    pair.reason=gap>=walk
      ?`Timetable connection possible: ${bus.arrival?'bus arrival':'bus departure, used as the latest arrival'} allows your walk before scheduled train departure; assumes trains do not leave early`
      :`${bus.arrival?'Bus arrival':'Bus departure, used as the arrival bound'} does not allow your walk before scheduled train departure. Likely missed on the timetable; a delayed train${!bus.arrival?' or an earlier bus arrival':''} could change this`;
  }
  function busLocation(bus,observed){const value=gps.get(key(bus));if(!value||observed.ambiguous||observed.startTimes&&[...observed.startTimes].some(t=>t&&value.startTime&&t!==value.startTime))return null;return value;}
  function locationEstimate(pair,observed){
    if(pair.status!=='unknown'||observed.ambiguous||!pair.busLocation)return;
    const g=pair.busLocation;
    let low,high;
    if(connection==='bus-train'){
      if(pair.trainDeparture==null)return;
      low=pair.trainDeparture-g.arrivalTo;high=g.arrivalFrom==null?null:pair.trainDeparture-g.arrivalFrom;
    }else{
      if(pair.trainArrival==null||g.departureTo==null)return;
      low=g.departureFrom-pair.trainArrival;high=g.departureTo-pair.trainArrival;
    }
    const possible=low>=walk&&(connection==='bus-train'||high<=window),missed=high!=null&&high<walk||connection==='train-bus'&&low>window;
    pair.gpsGapFrom=low;pair.gpsGapTo=high;
    if(possible||missed){pair.status=possible?'estimated-possible':'estimated-missed';pair.evidence='gps';pair.reason=possible?'GPS suggests enough transfer time; station presence does not confirm door opening':connection==='train-bus'&&low>window?'GPS suggests waiting longer than your connection window':'GPS suggests insufficient walking time';}
    else pair.reason='Bus seen dwelling near the station, but the GPS timing interval overlaps the transfer limit';
  }
  // A recorded departure bounds the preceding arrival, but does not supply an exact arrival.
  // Only a non-negative conservative margin can prove a connection; a negative one stays unknown.
  function evaluate(pair,origin,destination,originLabel,destinationLabel){
    if(origin.ambiguous||destination.ambiguous){pair.reason='Ambiguous trip instance';return;}
    if(!destination.departure){pair.reason=`${destinationLabel} departure not observed`;return;}
    const arrival=origin.arrival,upper=arrival?.event_time??origin.departure?.event_time;
    if(upper==null){pair.reason=`${originLabel} arrival and departure not observed`;return;}
    const gap=destination.departure.event_time-upper,margin=gap-walk;
    if(connection==='train-bus'&&!arrival&&gap<=window){pair.reason='Train departure confirms the station visit, but missing arrival prevents checking the maximum wait';return;}
    if(!arrival&&margin<0){pair.reason=`${originLabel} departure confirms the station visit, but arrival time is missing; transfer timing is uncertain`;return;}
    pair.gap=gap;pair.margin=margin;pair.gapIsMinimum=!arrival;pair.evidence=arrival?'exact':'conservative';
    pair.status=margin>=0?'possible':'missed';
    pair.reason=!arrival?`Possible even using ${originLabel.toLowerCase()} departure as the latest arrival; exact arrival missing`:margin>=0?'Enough recorded time to walk between services':gap>=0?'Less than your walking allowance':`${destinationLabel} left before ${originLabel.toLowerCase()} arrived`;
    if(connection==='train-bus'&&gap>window){pair.status='missed';pair.reason=`Bus left ${!arrival?'at least ':''}${(gap/60).toFixed(1)} minutes after train arrival, outside the ${window/60}-minute connection window`;}
  }
  for(const bus of (connection==='bus-train'?returns:[]).filter(r=>r.service_date>=from&&r.service_date<=to).sort((a,b)=>b.scheduled_time-a.scheduled_time)){
    const observed=observations.get(key(bus))||{},arrival=observed.arrival;
    if(bus.scheduled_time>now&&!arrival&&!observed.departure)continue;
    const plannedBus=arrival?.scheduled_time??bus.scheduled_time;
    // Choose the intended service by the timetable, before examining actual delays.
    // Otherwise choosing any later train would misleadingly make success approach 100%.
    const target=trains[lowerBound(plannedBus+walk)];
    const pair={serviceDate:bus.service_date,busServiceDate:bus.service_date,busTrip:bus.trip_id,busSequence:bus.sequence,busStop:stopName(bus.stop_id),
      connection,busVisit:2,scheduledBus:plannedBus,busScheduleSource:arrival?.scheduled_time!=null?'arrival schedule':'station departure timetable',busTime:arrival?.event_time??null,busDelay:arrival?.delay_sec??null,busArrival:arrival?.event_time??null,busDeparture:observed.departure?.event_time??null,
      trainTrip:null,trainDestination:'',scheduledTrain:null,trainArrival:null,trainDeparture:null,trainDelay:null,
      busLocation:busLocation(bus,observed),
      gap:null,margin:null,status:'unknown',reason:'No matching train timetable captured'};
    if(cancelled.has(tripKey(bus))){pair.status='cancelled';pair.reason='376 trip reported cancelled';pairs.push(pair);continue;}
    if(target&&target.scheduled_time-plannedBus<=3600){
      const trainObserved=observations.get(key(target))||{};
      Object.assign(pair,{trainTrip:target.trip_id,trainServiceDate:target.service_date,trainDestination:target.destination,scheduledTrain:target.scheduled_time,
        trainArrival:trainObserved.arrival?.event_time??null,trainDeparture:trainObserved.departure?.event_time??null,
        trainDelay:trainObserved.departure?.delay_sec??trainObserved.arrival?.delay_sec??null});
      if(cancelled.has(tripKey(target))){pair.status='cancelled';pair.reason='Intended train reported cancelled';}
      else {evaluate(pair,observed,trainObserved,'Bus','Train');timetableFallback(pair,observed,trainObserved);if(!trainObserved.ambiguous){timingEstimates(pair,bus,target,observed,trainObserved);locationEstimate(pair,observed);}}
    }
    pending(pair);pairs.push(pair);
  }
  if(connection==='train-bus'){
    const buses=firstVisits.filter(r=>r.pickup_type!==1).sort((a,b)=>a.scheduled_time-b.scheduled_time);
    // The closest first-visit bus in a bounded schedule window, even if the planned gap is too short.
    // This reveals near-simultaneous arrivals and missed connections, rather than counting a bus 30 minutes later.
    for(const train of schedules.filter(r=>r.route_id===trainId&&/pukekohe/i.test(r.destination)&&r.service_date>=from&&r.service_date<=to).sort((a,b)=>b.scheduled_time-a.scheduled_time)){
      const trainObserved=observations.get(key(train))||{},plannedTrain=trainObserved.arrival?.scheduled_time??train.scheduled_time;
      if(train.scheduled_time>now&&!trainObserved.arrival&&!trainObserved.departure)continue;
      const bus=buses.filter(r=>Math.abs(r.scheduled_time-plannedTrain)<=window).sort((a,b)=>Math.abs(a.scheduled_time-plannedTrain)-Math.abs(b.scheduled_time-plannedTrain)||b.scheduled_time-a.scheduled_time)[0],observed=bus?observations.get(key(bus))||{}:{};
      const pair={connection,busVisit:1,serviceDate:train.service_date,trainServiceDate:train.service_date,busServiceDate:bus?.service_date??null,busTrip:bus?.trip_id??null,busSequence:bus?.sequence??null,busStop:bus?stopName(bus.stop_id):'Papakura Station',
        scheduledBus:bus?.scheduled_time??null,busScheduleSource:'station departure timetable',busTime:observed.departure?.event_time??null,busDelay:observed.departure?.delay_sec??null,busArrival:observed.arrival?.event_time??null,busDeparture:observed.departure?.event_time??null,
        trainTrip:train.trip_id,trainDestination:train.destination,scheduledTrain:plannedTrain,trainScheduleSource:trainObserved.arrival?.scheduled_time!=null?'arrival schedule':'station departure timetable',trainArrival:trainObserved.arrival?.event_time??null,trainDeparture:trainObserved.departure?.event_time??null,trainDelay:trainObserved.arrival?.delay_sec??trainObserved.departure?.delay_sec??null,
        busLocation:bus?busLocation(bus,observed):null,
        gap:null,margin:null,status:'unknown',reason:`No first-visit 376 timetable captured within ${window/60} minutes of the train`};
      if(cancelled.has(tripKey(train))){pair.status='cancelled';pair.reason='Train reported cancelled';}
      else if(bus&&cancelled.has(tripKey(bus))){pair.status='cancelled';pair.reason='Intended 376 reported cancelled';}
      else if(bus){evaluate(pair,trainObserved,observed,'Train','Bus');if(!trainObserved.ambiguous){timingEstimates(pair,bus,train,observed,trainObserved);locationEstimate(pair,observed);}}
      pending(pair);pairs.push(pair);
    }
  }
  const matching=pairs.filter(p=>(p.scheduledBus!=null?Search.clockMatch(p.scheduledBus,transferFrom,transferTo):!transferFrom&&!transferTo)&&(!transferSearch||Search.fold(`${p.serviceDate} ${p.busTrip} ${p.trainTrip||''} ${p.trainDestination} ${p.reason}`).includes(Search.fold(transferSearch))));
  const possible=matching.filter(p=>p.status==='possible').length,missed=matching.filter(p=>p.status==='missed').length,visible=matching.filter(p=>result==='all'||p.status===result);
  return {walk,direction,connection,window,totalPairs:visible.length,summary:{returnVisits:matching.length,possible,missed,timetablePossible:matching.filter(p=>p.evidence==='timetable'&&p.status==='estimated-possible').length,timetableMissed:matching.filter(p=>p.evidence==='timetable'&&p.status==='estimated-missed').length,pending:matching.filter(p=>p.status==='pending').length,estimatedUncertain:matching.filter(p=>p.status==='estimated-uncertain').length,estimatedPossible:matching.filter(p=>p.status==='estimated-possible').length,estimatedMissed:matching.filter(p=>p.status==='estimated-missed').length,locationVisits:matching.filter(p=>p.busLocation).length,conservative:matching.filter(p=>p.evidence==='conservative').length,exact:matching.filter(p=>p.evidence==='exact').length,unknown:matching.filter(p=>p.status==='unknown').length,
    cancelled:matching.filter(p=>p.status==='cancelled').length,unclassifiedVisits:unclassified.length,measured:possible+missed,
    successPercent:possible+missed?100*possible/(possible+missed):null},hourly:Hours.transfers(matching,connection),pairs:visible.slice(0,200)};
}
module.exports={stopCode,stopName,stationCodes,timetableIds,scheduleRows,transferOptions,analyze,bounds};
