const T = require('../transit-data.js');
const S = require('../schedule-data.js');
const canonical = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateAt = seconds => dateFormatter.format(new Date(seconds * 1000));
const number = value => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? (Number.isFinite(Number(value)) ? Number(value) : null) : null;
function serviceDate(value, fallback) {
  const text = String(value ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  return S.validDate(text) ? text : dateAt(fallback);
}
function matches(route, descriptor, metadata) {
  if (route.route_id) return route.route_id === descriptor.route_id;
  if (metadata) {
    if (Number(metadata.route_type) !== (route.mode === 'bus' ? 3 : 2)) return false;
    return canonical(metadata.route_short_name) === canonical(route.code) || canonical(metadata.route_long_name) === canonical(route.code);
  }
  // Versioned route IDs have a hyphen followed by digits. No substring matching.
  return canonical(String(descriptor.route_id ?? '').replace(/-\d.*$/, '')) === canonical(route.code);
}
function extract(feed, routes, metadata, now = Date.now() / 1000) {
  const header = number(feed?.response?.header?.timestamp ?? feed?.header?.timestamp);
  if (header !== null && (now - header > 120 || header > now + 30)) throw Error('Feed timestamp is stale or in the future');
  if (!feed || !(feed.response?.entity !== undefined || feed.entity !== undefined)) throw Error('Feed is missing its entity list');
  const events = [], cancellations = [],predictions=[],progress=[],invalidStops=[],adherence=[];
  const routeMatches = new Map();
  let ignored = 0;
  for (const entity of T.entities(feed)) {
    if (entity.is_deleted || entity.isDeleted) continue;
    const update = entity.trip_update ?? entity.tripUpdate;
    const trip = update?.trip;
    if (!trip?.trip_id) continue;
    // Hundreds of trips share route IDs. Resolve each ID once per snapshot.
    if(!routeMatches.has(trip.route_id))routeMatches.set(trip.route_id,routes.find(r => r.active && matches(r, trip, metadata.get(trip.route_id)))||null);
    const route = routeMatches.get(trip.route_id);
    if (!route) continue;
    const stamp = number(update.timestamp) ?? header;
    if (stamp === null || stamp > now + 30 || now-stamp>120&&header===null) { ignored++; continue; }
    const fresh=now-stamp<=120;
    const date = serviceDate(trip.start_date, stamp), startTime = String(trip.start_time ?? '');
    const base = { routeId: route.id, tripId: String(trip.trip_id), serviceDate: date, startTime, reportedAt: stamp };
    if (T.canceled(update)) { cancellations.push(base); continue; }
    if(fresh){const relevant=T.relevantStop(update,null,now);adherence.push({...base,code:route.code,vehicleLabel:String(update.vehicle?.label||update.vehicle?.id||''),sequence:relevant?.stop_sequence??null,stopId:relevant?.stop_id??null,delaySec:T.tripDelay(update,null,now)});
      for(const stop of T.list(update.stop_time_update??update.stopTimeUpdate))if(['2716','9228','9229','9230'].includes(T.stopCode(stop.stop_id))&&[1,2,3,'SKIPPED','NO_DATA','CANCELED','CANCELLED'].includes(typeof stop.schedule_relationship==='string'&&/^\d+$/.test(stop.schedule_relationship)?Number(stop.schedule_relationship):stop.schedule_relationship))invalidStops.push({...base,stopId:stop.stop_id,sequence:Number(stop.stop_sequence)});}
    for (const stop of T.stopUpdates(update)) {
      if (!stop.stop_id || number(stop.stop_sequence) === null) { ignored++; continue; }
      for (const kind of ['arrival', 'departure']) {
        const time = number(stop[kind]?.time), delay = number(stop[kind]?.delay);
        const uncertainty=number(stop[kind]?.uncertainty);
        if(fresh&&['2716','9228','9229','9230'].includes(T.stopCode(stop.stop_id))&&time!==null&&time>=now-86400&&time<=now+7200)predictions.push({...base,stopId:String(stop.stop_id),sequence:Number(stop.stop_sequence),kind,eventTime:time,delaySec:delay,uncertainty,capturedAt:now});
        // Never archive future predictions as observed performance. Delay-only updates
        // cannot establish whether a stop event has occurred.
        if (time === null || time < stamp - 86400 || time > now || time>stamp&&!(fresh&&uncertainty===0&&header!==null&&time<=header)) { if (stop[kind]) ignored++; continue; }
        events.push({ ...base, stopId: String(stop.stop_id), sequence: Number(stop.stop_sequence), kind,
          eventTime: time, delaySec: delay, scheduledTime: delay === null ? null : time - delay });
        if(uncertainty==null||uncertainty===0)progress.push({...base,sequence:Number(stop.stop_sequence),eventTime:time});
      }
    }
  }
  return { events, cancellations, ignored,predictions,progress,invalidStops,adherence };
}

module.exports = { extract, matches, canonical, dateAt };
