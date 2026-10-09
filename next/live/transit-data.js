// Pure feed adapters shared by browser code and offline regression tests.
(function(root){
  const list=value=>Array.isArray(value)?value:value && typeof value==='object'?[value]:[];
  const number=value=>!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))?null:Number(value);
  function entities(feed){ return list(feed?.response?.entity??feed?.entity).filter(e=>e && typeof e==='object'); }
  function relationship(value){ return typeof value==='string' && !/^\d+$/.test(value)?value.toUpperCase():number(value); }
  function canceled(update){ return [3,7,'CANCELED','CANCELLED','DELETED'].includes(relationship(update?.trip?.schedule_relationship??update?.trip?.scheduleRelationship)); }
  function stopUpdates(update){
    if(!update || canceled(update)) return [];
    return list(update.stop_time_update??update.stopTimeUpdate).filter(s=>s && typeof s==='object' &&
      ![1,2,3,'SKIPPED','NO_DATA','CANCELED','CANCELLED'].includes(relationship(s.schedule_relationship??s.scheduleRelationship)));
  }
  // AT stop IDs use a stable numeric code plus an export-specific hexadecimal suffix.
  // Never strip arbitrary identifiers or guess when one code maps to multiple stations.
  function stopCode(id){ return String(id??'').trim().match(/^(\d+)(?:-[a-f\d]{6,})?$/i)?.[1]||null; }
  function stopAliases(exact){
    const aliases=new Map();
    for(const [id,key] of exact){
      const code=stopCode(id); if(!code) continue;
      if(!aliases.has(code)) aliases.set(code,key);
      else if(aliases.get(code)!==key) aliases.set(code,null);
    }
    return aliases;
  }
  function resolveStop(id,exact,aliases){
    const key=String(id??'').trim();
    return exact.get(key)||aliases.get(stopCode(key))||null;
  }
  function validPosition(position){
    const lat=number(position?.latitude),lon=number(position?.longitude);
    return lat!==null && lon!==null && Math.abs(lat)<=90 && Math.abs(lon)<=180;
  }
  function bikesAllowed(value){return number(value)===1?'Yes':number(value)===2?'No':'';}
  function carriageCount(position){
    const cars=position?.multi_carriage_details??position?.multiCarriageDetails;
    if(!Array.isArray(cars)||!cars.length)return null;
    // GTFS requires a complete ordered set, including non-boardable carriages.
    return cars.every((c,i)=>number(c?.carriage_sequence??c?.carriageSequence)===i+1)?cars.length:null;
  }
  function buildArrivals(updates,{now,resolveStop,serviceForTrip,sequenceForTrip=()=>null}){
    const byStop=new Map(),dedupe=new Map();
    const stats={trips:0,multiStopTrips:0,unmatchedStops:0,missingTimes:0,staleTrips:0,entries:0};
    for(const [tripId,tu] of updates){
      if(canceled(tu)) continue;
      stats.trips++;
      const stops=stopUpdates(tu),stamp=number(tu.timestamp);
      if(stops.length>1) stats.multiStopTrips++;
      // An old trip update is not a current prediction even when the feed header is fresh.
      if(stamp!==null && now-stamp>120){ stats.staleTrips++; continue; }
      const sequence=number(sequenceForTrip(tripId));
      const service=serviceForTrip(tripId,tu);
      for(const s of stops){
        const seq=number(s.stop_sequence??s.stopSequence);
        if(sequence!==null && seq!==null && seq<sequence) continue;
        const arrival=number(s.arrival?.time),departure=number(s.departure?.time);
        // A train dwelling at the platform can have an arrival in the past and departure ahead.
        const eta=departure!==null && departure>=now && (arrival===null||arrival<now)?departure:arrival??departure;
        if(eta===null){ stats.missingTimes++; continue; }
        if(eta<now-30 || eta>now+3600) continue;
        const stopId=s.stop_id??s.stopId,key=resolveStop(stopId);
        if(!key){ stats.unmatchedStops++; continue; }
        const identity=`${tripId}|${key}|${seq??eta}`;
        if(dedupe.has(identity)) continue;
        dedupe.set(identity,true);
        if(!byStop.has(key)) byStop.set(key,[]);
        byStop.get(key).push({...service,tripId,stopId,etaSec:eta,delaySec:number(s.arrival?.delay)??number(s.departure?.delay)});
        stats.entries++;
      }
    }
    return {byStop,stats};
  }
  function groupBusStations(rows){
    const groups=new Map(),selected=new Set(),stations=[];
    const hubs=new Set(['lower albert','onehunga','new lynn','akoranga','constellation','hibiscus coast','sunnynook','smales farm','westgate','puhinui','takapuna','ormiston town centre']);
    const base=name=>name.replace(/^(?:Stop\s+[A-Z]|Bay\s+\d+)\s+/i,'').trim();
    for(const row of rows) if(row.type===0 && row.parent){
      if(!groups.has(row.parent)) groups.set(row.parent,[]);
      groups.get(row.parent).push(row);
    }
    for(const [parent,bays] of groups){
      if(bays.length<2) continue;
      const names=bays.map(row=>base(row.name));
      // Explicit station/interchange names or established bus hubs, never arbitrary road groups.
      if(!names.some(name=>/\b(?:bus station|bus interchange|transport centre|station|interchange)\b/i.test(name)||hubs.has(name.toLowerCase()))) continue;
      const name=names.find(name=>/\bstation\b/i.test(name))||names[0];
      const platforms=bays.map(row=>({id:row.id,code:row.code,name:row.name,description:row.description||'',
        label:row.name.match(/^(Stop\s+[A-Z]|Bay\s+\d+)\b/i)?.[1]||row.name}));
      stations.push({type:3,parent,name:/\b(?:bus|interchange|transport centre)\b/i.test(name)?name:`${name} Bus Interchange`,
        lat:bays.reduce((n,row)=>n+row.lat,0)/bays.length,lon:bays.reduce((n,row)=>n+row.lon,0)/bays.length,
        code:'',id:'',platforms});
      bays.forEach(row=>selected.add(row));
    }
    const counts=new Map();
    for(const station of stations) counts.set(station.name,(counts.get(station.name)||0)+1);
    for(const station of stations) if(counts.get(station.name)>1){
      station.name+=` (${station.platforms.map(p=>p.label).join(', ')})`;
    }
    return [...rows.filter(row=>!selected.has(row)),...stations];
  }
  function relevantStop(update,currentSequence,now=Date.now()/1000){
    const stops=stopUpdates(update);if(!stops.length)return null;
    if(currentSequence!=null){const candidates=stops.filter(s=>number(s.stop_sequence??s.stopSequence)!=null&&number(s.stop_sequence??s.stopSequence)>=currentSequence).sort((a,b)=>number(a.stop_sequence??a.stopSequence)-number(b.stop_sequence??b.stopSequence));return candidates[0]||null;}
    return stops.find(s=>(number(s.departure?.time)??number(s.arrival?.time)??0)>=now-30)||stops[stops.length-1];
  }
  function tripDelay(update,currentSequence,now=Date.now()/1000){const stop=relevantStop(update,currentSequence,now);return number(stop?.arrival?.delay)??number(stop?.departure?.delay)??number(update?.delay);}
  const api={list,number,entities,canceled,stopUpdates,stopCode,stopAliases,resolveStop,validPosition,bikesAllowed,carriageCount,buildArrivals,groupBusStations,relevantStop,tripDelay};
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.TransitData=api;
})(typeof globalThis==='object'?globalThis:window);
