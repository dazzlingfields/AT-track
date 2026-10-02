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
  const api={list,number,entities,canceled,stopUpdates,stopCode,stopAliases,resolveStop,validPosition,bikesAllowed,buildArrivals};
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.TransitData=api;
})(typeof globalThis==='object'?globalThis:window);
