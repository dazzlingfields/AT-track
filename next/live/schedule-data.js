// Schedule parsing shared by the browser and the departures proxy. No API credentials.
(function(root){
  const zone='Pacific/Auckland';
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const array=value=>Array.isArray(value)?value:value && typeof value==='object'?[value]:[];
  const number=value=>!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))?null:Number(value);
  const relationship=value=>typeof value==='string' && !/^\d+$/.test(value)?value.toUpperCase():number(value);
  const unavailable=stop=>[1,2,3,'SKIPPED','NO_DATA','CANCELED','CANCELLED'].includes(relationship(stop?.schedule_relationship??stop?.scheduleRelationship));
  function parts(epoch){
    const p={};formatter.formatToParts(new Date(epoch*1000)).forEach(x=>{if(x.type!=='literal') p[x.type]=Number(x.value);});
    return p;
  }
  function dateString(p){return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
  function validDate(date){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')) return false;
    const [y,m,d]=date.split('-').map(Number),stamp=Date.UTC(y,m-1,d);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10)===date;
  }
  function shiftDate(date,days){return new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);}
  function localEpoch(date,hour,minute=0,second=0){
    if(!validDate(date) || hour>23 || minute>59 || second>59) return null;
    const [y,m,d]=date.split('-').map(Number),target=Date.UTC(y,m-1,d,hour,minute,second)/1000;
    let guess=target;
    for(let i=0;i<4;i++){
      const p=parts(guess),actual=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)/1000;
      if(actual===target) return guess;
      guess+=target-actual;
    }
    return null; // nonexistent local clock time on a daylight-saving transition
  }
  function serviceBase(date){
    // GTFS measures service times from local noon minus 12 elapsed hours, including DST days.
    const noon=localEpoch(date,12);return noon===null?null:noon-43200;
  }
  function timeEpoch(value,date){
    if(value==null || value==='') return null;
    if(typeof value==='number' || /^\d{10}(?:\.\d+)?$/.test(String(value))){
      const n=Number(value);return Number.isFinite(n) && n>=1000000000 && n<100000000000?n:null;
    }
    if(typeof value!=='string') return null;
    const text=value.trim(),clock=text.match(/^(\d{1,2}):([0-5]\d):([0-5]\d)$/);
    if(clock){
      const base=serviceBase(date),hour=Number(clock[1]);
      return base===null || hour>71?null:base+hour*3600+Number(clock[2])*60+Number(clock[3]);
    }
    // A date alone contains no departure time; never interpret it as midnight.
    if(/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const iso=text.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):([0-5]\d):([0-5]\d)(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
    if(!iso || !validDate(iso[1]) || Number(iso[2])>23) return null;
    if(iso[5]){const n=Date.parse(text.replace(' ','T'))/1000;return Number.isFinite(n)?n:null;}
    return localEpoch(iso[1],Number(iso[2]),Number(iso[3]),Number(iso[4]));
  }
  function windows(now,horizon=3600){
    const p=parts(now),date=dateString(p),end=parts(now+horizon),endDate=dateString(end);
    const windowFor=day=>{
      // Include the previous hour so a delayed train is still available for live matching.
      const base=serviceBase(day),startHour=Math.max(0,Math.floor((now-base)/3600)-1);
      return {date:day,startHour,hourRange:Math.max(1,Math.ceil((now+horizon-base)/3600)-startHour)};
    };
    const result=[windowFor(date)];
    if(p.hour<6) result.push(windowFor(shiftDate(date,-1)));
    if(endDate!==date) result.push({date:endDate,startHour:0,hourRange:Math.max(1,end.hour+1)});
    return result;
  }
  function sameStop(a,b){
    if(!a || !b) return false;
    if(String(a)===String(b)) return true;
    const code=id=>String(id).match(/^(\d+)(?:-[a-f\d]{6,})?$/i)?.[1];
    return !!code(a) && code(a)===code(b);
  }
  function resources(payload){return [...array(payload?.data),...array(payload?.included)].filter(r=>r && typeof r==='object');}
  function tripId(row){
    const a=row.attributes||row;
    return a.trip_id??row.relationships?.trip?.data?.id??(row.type==='trip'?row.id:null);
  }
  function candidates(payload,stopId,date){
    const output=new Map();
    for(const row of resources(payload)){
      const a=row.attributes||row,id=tripId(row);
      if(!id || (a.stop_id && !sameStop(a.stop_id,stopId))) continue;
      const key=`${id}|${a.stop_sequence??''}`;
      const existing=output.get(key)||{};
      output.set(key,{...existing,tripId:String(id),serviceDate:a.service_date||date,stopId:a.stop_id||stopId,
        sequence:a.stop_sequence??existing.sequence,routeId:a.route_id??existing.routeId,
        destination:a.stop_headsign||a.trip_headsign||existing.destination||'',pickupType:a.pickup_type??existing.pickupType,
        arrivalTime:a.arrival_time??existing.arrivalTime,departureTime:a.departure_time??existing.departureTime});
    }
    return [...output.values()];
  }
  function departure(candidate){
    if(Number(candidate.pickupType)===1) return null; // drop-off only
    const time=timeEpoch(candidate.departureTime??candidate.arrivalTime,candidate.serviceDate);
    return time===null?null:{tripId:candidate.tripId,serviceDate:candidate.serviceDate,stopId:candidate.stopId,
      sequence:candidate.sequence??null,routeId:candidate.routeId||'',destination:candidate.destination||'',
      scheduledTime:time,scheduledArrival:timeEpoch(candidate.arrivalTime,candidate.serviceDate),
      scheduledDeparture:timeEpoch(candidate.departureTime,candidate.serviceDate),pickupType:candidate.pickupType??0};
  }
  // Like performance/transfers.cjs, apply a last reported delay to the timetable.
  // A public upcoming board requires fresh, dated evidence and never back-projects.
  function upstreamDelay(stops,tu,row,now,stamp){
    const target=number(row.sequence);
    if(target===null || stamp===null || now-stamp>120 || stamp>now+30) return null;
    const previous=stops.filter(s=>number(s.stop_sequence??s.stopSequence)!==null &&
      number(s.stop_sequence??s.stopSequence)<target).sort((a,b)=>number(b.stop_sequence??b.stopSequence)-number(a.stop_sequence??a.stopSequence));
    for(const stop of previous){
      if(unavailable(stop)) return null; // NO_DATA ends carried delay information.
      for(const event of [stop.departure,stop.arrival]){
        const time=number(event?.time),delay=number(event?.delay);
        if(delay!==null && time!==null && time<=now && now-time<=300) return {delay,source:'upstream',reportedAt:stamp};
      }
    }
    const delay=number(tu.delay);
    return delay!==null?{delay,source:'trip',reportedAt:stamp}:null;
  }
  function mergeDepartures(schedules,updates,{now,liveFresh=true,sequenceForTrip=()=>null}){
    const result=[],seen=new Set();
    for(const row of schedules){
      let time=number(row.scheduledTime),status='scheduled',delay=null,source=null,timingKind='departure';
      if(time===null || time<=0) continue;
      const tu=updates.get(row.tripId);
      const date=String(tu?.trip?.start_date??tu?.trip?.startDate??'').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
      const sameDay=!date || date===row.serviceDate;
      const normalize=relationship;
      const relation=normalize(tu?.trip?.schedule_relationship??tu?.trip?.scheduleRelationship);
      const canceled=sameDay && [3,7,'CANCELED','CANCELLED','DELETED'].includes(relation);
      const stamp=number(tu?.timestamp);
      const fresh=liveFresh && tu && sameDay && (tu.timestamp==null || stamp!==null && now-stamp<=120 && stamp<=now+30);
      if(canceled) status='canceled';
      else if(fresh){
        const sequence=sequenceForTrip(row.tripId);
        if(sequence!=null && row.sequence!=null && Number(sequence)>Number(row.sequence)) continue;
        const stops=array(tu.stop_time_update??tu.stopTimeUpdate);
        // A later observed stop proves this visit is over; a future forecast does not.
        if(row.sequence!=null && stops.some(s=>!unavailable(s) && number(s.stop_sequence??s.stopSequence)>Number(row.sequence) &&
          [s.arrival,s.departure].some(e=>number(e?.time)!==null && number(e.time)>0 && number(e.time)<=now))) continue;
        const stop=stops.find(s=>sameStop(s.stop_id??s.stopId,row.stopId) &&
          (row.sequence==null || (s.stop_sequence??s.stopSequence)==null || Number(s.stop_sequence??s.stopSequence)===Number(row.sequence)));
        if(stop){
          const relation=normalize(stop.schedule_relationship??stop.scheduleRelationship);
          if([1,2,3,'SKIPPED','NO_DATA','CANCELED','CANCELLED'].includes(relation)){
            if([1,3,'SKIPPED','CANCELED','CANCELLED'].includes(relation)) status='canceled';
          }else{
            const valid=e=>number(e?.time)>0 || number(e?.delay)!==null;
            const event=valid(stop.departure)?stop.departure:stop.arrival;
            const clock=number(event?.time),offset=number(event?.delay);
            if(clock!==null && clock>0){
              time=clock;status='live';source='stop';
              timingKind=event===stop.arrival?'arrival':'departure';
              const scheduled=timingKind==='arrival'?number(row.scheduledArrival):number(row.scheduledTime);
              delay=offset??(scheduled===null?null:clock-scheduled);
            }else if(offset!==null){time+=offset;status='estimated';delay=offset;source='stop';}
          }
        }
        if(status==='scheduled' && (!stop || !unavailable(stop)) && date===row.serviceDate){
          const evidence=upstreamDelay(stops,tu,row,now,stamp);
          if(evidence){time+=evidence.delay;delay=evidence.delay;status='estimated';source=evidence.source;}
        }
      }
      if(time<now-15 || time>now+3600) continue;
      const key=`${row.tripId}|${row.serviceDate}|${row.sequence??row.scheduledTime}`;
      if(seen.has(key)) continue;seen.add(key);
      result.push({...row,etaSec:time,status,delaySec:delay,delaySource:source,timingKind,reportedAt:source?stamp:null});
    }
    return result.sort((a,b)=>a.etaSec-b.etaSec);
  }
  function delaySummary(rows){
    const known=rows.filter(r=>['live','estimated'].includes(r.status) && number(r.delaySec)!==null);
    return {count:known.length,total:rows.filter(r=>r.status!=='canceled').length,
      estimated:known.filter(r=>r.status==='estimated').length,
      average:known.length?known.reduce((sum,r)=>sum+number(r.delaySec),0)/known.length:null};
  }
  const api={zone,parts,dateString,validDate,shiftDate,localEpoch,serviceBase,timeEpoch,windows,sameStop,resources,tripId,candidates,departure,mergeDepartures,delaySummary};
  if(typeof module==='object' && module.exports) module.exports=api;else root.ScheduleData=api;
})(typeof globalThis==='object'?globalThis:window);
