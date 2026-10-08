import Trips from '../trips.cjs';
import Hours from '../hours.cjs';
import Feed from '../feed.cjs';
import Transfers from '../transfers.cjs';
import Search from '../search.cjs';
import Retention from '../retention.cjs';
import Positions from '../positions.cjs';
import Occupancy from '../occupancy.cjs';
import Predictions from '../predictions.cjs';
const { canonical }=Feed;
const eventWhere='service_date BETWEEN ? AND ? AND (?=0 OR route_id=?) AND kind=?';
function aggregate(early,late) {
  return `COUNT(*) AS observations,COUNT(delay_sec) AS measured,COUNT(*)-COUNT(delay_sec) AS unknown,
    COALESCE(SUM(delay_sec BETWEEN ${-early} AND ${late}),0) AS onTime,
    COALESCE(SUM(delay_sec < ${-early}),0) AS early,COALESCE(SUM(delay_sec > ${late}),0) AS late,
    100.0*SUM(delay_sec BETWEEN ${-early} AND ${late})/NULLIF(COUNT(delay_sec),0) AS onTimePercent,
    AVG(delay_sec) AS averageDelay,COUNT(DISTINCT json_array(route_id,trip_id,service_date,start_time)) AS trips`;
}
const empty={observations:0,measured:0,unknown:0,onTime:0,early:0,late:0,onTimePercent:null,averageDelay:null,trips:0};
export class CloudStore {
  constructor(db){this.db=db;this.rowsWritten=0;}
  countWrites(result){this.rowsWritten+=result?.meta?.rows_written||0;return result;}
  async all(sql,...args){return (await this.db.prepare(sql).bind(...args).all()).results;}
  async first(sql,...args){return this.db.prepare(sql).bind(...args).first();}
  async run(sql,...args){return this.countWrites(await this.db.prepare(sql).bind(...args).run());}
  async routes(){return this.all('SELECT * FROM routes ORDER BY id');}

  async missingTimetables(rows){if(!rows.length)return [];return this.all("SELECT json_extract(j.value,'$.route_id') route_id,json_extract(j.value,'$.trip_id') trip_id,json_extract(j.value,'$.service_date') service_date FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM trip_timetables t WHERE t.route_id=json_extract(j.value,'$.route_id') AND t.trip_id=json_extract(j.value,'$.trip_id') AND t.service_date=json_extract(j.value,'$.service_date'))",JSON.stringify(rows));}
  async archiveTimetables(rows){if(rows.length)await this.run(Trips.archiveSql,JSON.stringify(rows));}
  async tripData({routeId,date,tripId=''}){const all=!tripId;const statements=[this.db.prepare('SELECT * FROM trip_timetables WHERE route_id=? AND service_date=? AND (? OR trip_id=?)').bind(routeId,date,all?1:0,tripId),this.db.prepare('SELECT * FROM events WHERE route_id=? AND service_date=? AND (? OR trip_id=?)').bind(routeId,date,all?1:0,tripId),this.db.prepare('SELECT * FROM cancellations WHERE route_id=? AND service_date=? AND (? OR trip_id=?)').bind(routeId,date,all?1:0,tripId)];const [archives,events,cancellations]=(await this.db.batch(statements)).map(r=>r.results);return {archives,events,cancellations};}
  async purgeHistory(now=Date.now()){
    const policy=Retention.policy(now),previous=await this.getState('retention');
    if(previous?.today===policy.today&&previous?.months===policy.months)return previous;
    const statements=Retention.tables.map(table=>this.db.prepare(`DELETE FROM ${table} WHERE service_date < ?`).bind(policy.cutoff));
    statements.push(this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').bind('retention',JSON.stringify(policy)));
    // D1 batch is transactional: mark completion only when all history tables were purged.
    await this.db.batch(statements);return policy;
  }
  async getState(key){const row=await this.first('SELECT value FROM state WHERE key=?',key);return row?JSON.parse(row.value):null;}
  async setState(key,value){await this.run('INSERT INTO state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE state.value IS NOT excluded.value',key,JSON.stringify(value));}
  async addRoute({code,name,mode,routeId=''}){
    code=String(code??'').trim().toUpperCase();name=String(name??'').trim();routeId=String(routeId).trim();
    if(!/^[A-Z0-9][A-Z0-9 -]{0,39}$/.test(code)||!name||name.length>100||!['bus','train'].includes(mode)||routeId.length>100)throw Error('Enter a route code, name and bus/train mode');
    const routes=await this.routes();if(routes.some(r=>r.mode===mode&&canonical(r.code)===canonical(code)))throw Error('This route is already tracked');
    if(routes.length>=100)throw Error('At most 100 routes can be tracked');
    await this.run('INSERT INTO routes(code,name,mode,route_id) VALUES(?,?,?,?)',code,name,mode,routeId);
  }
  async toggle(id,active){return this.run('UPDATE routes SET active=? WHERE id=?',active?1:0,id);}
  async ingest(batch){
    // JSON ingestion uses two SQL statements regardless of the number of stops.
    // Repeated unchanged events perform no writes, preserving the free D1 quota.
    const e=`INSERT INTO events SELECT
      json_extract(value,'$.routeId'),json_extract(value,'$.tripId'),json_extract(value,'$.serviceDate'),
      json_extract(value,'$.startTime'),json_extract(value,'$.stopId'),json_extract(value,'$.sequence'),
      json_extract(value,'$.kind'),json_extract(value,'$.eventTime'),json_extract(value,'$.scheduledTime'),
      json_extract(value,'$.delaySec'),json_extract(value,'$.reportedAt') FROM json_each(?) WHERE 1
      ON CONFLICT DO UPDATE SET event_time=excluded.event_time,
      scheduled_time=COALESCE(excluded.scheduled_time,events.scheduled_time),delay_sec=COALESCE(excluded.delay_sec,events.delay_sec),reported_at=excluded.reported_at
      WHERE excluded.reported_at>events.reported_at AND (excluded.event_time!=events.event_time OR
      (excluded.delay_sec IS NOT NULL AND excluded.delay_sec IS NOT events.delay_sec))`;
    const c=`INSERT INTO cancellations SELECT json_extract(value,'$.routeId'),json_extract(value,'$.tripId'),
      json_extract(value,'$.serviceDate'),json_extract(value,'$.startTime'),json_extract(value,'$.reportedAt')
      FROM json_each(?) WHERE 1 ON CONFLICT DO NOTHING`;
    const statements=[];
    if(batch.events.length)statements.push(this.db.prepare(e).bind(JSON.stringify(batch.events)));
    if(batch.cancellations.length)statements.push(this.db.prepare(c).bind(JSON.stringify(batch.cancellations)));
    for(const q of Predictions.statements(batch))statements.push(this.db.prepare(q.sql).bind(...q.params));
    if(statements.length)for(const result of await this.db.batch(statements))this.countWrites(result);
  }
  async report(filters){
    const {from,to,routeId,kind,early,late,page=1}=filters,{where:eventWhere,params}=Search.eventSql(filters),agg=aggregate(early,late);
    const ranked=(late)=>`WITH matched AS(SELECT * FROM events WHERE ${eventWhere} AND delay_sec${late?'>':'<'}0),
      services AS(SELECT *,ROW_NUMBER() OVER(PARTITION BY service_date,route_id,trip_id,start_time ORDER BY delay_sec ${late?'DESC':'ASC'},event_time DESC,stop_id,sequence) AS service_rank FROM matched),
      days AS(SELECT *,ROW_NUMBER() OVER(PARTITION BY service_date ORDER BY delay_sec ${late?'DESC':'ASC'},event_time DESC,route_id,trip_id) AS day_rank FROM services WHERE service_rank=1)
      SELECT * FROM days WHERE day_rank<=5 ORDER BY service_date DESC,day_rank`;
    const hourQuery=Hours.routeQuery(filters);
    const statements=[
      this.db.prepare(`SELECT ${agg} FROM events WHERE ${eventWhere}`).bind(...params),
      this.db.prepare(`SELECT route_id,${agg} FROM events WHERE ${eventWhere} GROUP BY route_id`).bind(...params),
      this.db.prepare(`SELECT service_date AS date,${agg} FROM events WHERE ${eventWhere} GROUP BY service_date ORDER BY service_date`).bind(...params),
      this.db.prepare(`SELECT * FROM events WHERE ${eventWhere} ORDER BY event_time DESC,trip_id,stop_id,sequence LIMIT 200 OFFSET ?`).bind(...params,(page-1)*200),
      this.db.prepare('SELECT route_id,COUNT(*) AS count FROM cancellations WHERE service_date BETWEEN ? AND ? AND (?=0 OR route_id=?) GROUP BY route_id').bind(from,to,routeId,routeId),
      this.db.prepare('SELECT * FROM routes ORDER BY id'),
      this.db.prepare(`SELECT route_id,CASE WHEN instr(stop_id,'-')>0 THEN substr(stop_id,1,instr(stop_id,'-')-1) ELSE stop_id END AS stop_code,
        ${agg},COALESCE(SUM(delay_sec<0),0) AS ahead,COALESCE(SUM(delay_sec>0),0) AS behind,MIN(delay_sec) AS earliest,MAX(delay_sec) AS latest
        FROM events WHERE ${eventWhere} GROUP BY route_id,stop_code ORDER BY route_id,stop_code`).bind(...params),
      this.db.prepare(ranked(true)).bind(...params),this.db.prepare(ranked(false)).bind(...params),this.db.prepare(hourQuery.sql).bind(...hourQuery.params)];
    const results=await this.db.batch(statements),[total,perRoute,daily,events,cancel,routes,stops,lateServices,earlyServices,hourly]=results.map(r=>r.results);
    const cancels=new Map(cancel.map(r=>[r.route_id,r.count]));
    return {...filters,summary:{...total[0],cancellations:cancel.reduce((sum,r)=>sum+r.count,0)},
      routes:routes.map(r=>({...r,...empty,...perRoute.find(p=>p.route_id===r.id),cancellations:cancels.get(r.id)||0})),
      daily,hourly:Hours.normalize(hourly),events:events.map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)})),
      extremes:[...new Set([...lateServices,...earlyServices].map(e=>e.service_date))].sort().reverse().map(date=>({date,
        late:lateServices.filter(e=>e.service_date===date).map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)})),
        early:earlyServices.filter(e=>e.service_date===date).map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)}))})),page,pageSize:200,
      stops:stops.map(s=>({...s,stop_name:Transfers.stopName(s.stop_code)})),totalEvents:total[0].observations};
  }
  async saveSchedules(rows){
    if(!rows.length)return;
    await this.run(`INSERT INTO station_schedules SELECT json_extract(value,'$.route_id'),json_extract(value,'$.trip_id'),
      json_extract(value,'$.service_date'),json_extract(value,'$.stop_id'),json_extract(value,'$.stop_code'),json_extract(value,'$.sequence'),
      json_extract(value,'$.scheduled_time'),json_extract(value,'$.destination'),json_extract(value,'$.pickup_type'),json_extract(value,'$.seen_at')
      FROM json_each(?) WHERE 1 ON CONFLICT DO UPDATE SET scheduled_time=excluded.scheduled_time,destination=excluded.destination,
      pickup_type=excluded.pickup_type,seen_at=excluded.seen_at WHERE excluded.scheduled_time!=station_schedules.scheduled_time
      OR excluded.destination!=station_schedules.destination OR excluded.pickup_type!=station_schedules.pickup_type`,JSON.stringify(rows));
  }
  async transfers(filters){
    const range=Transfers.bounds(filters.from,filters.to),code="CASE WHEN instr(stop_id,'-')>0 THEN substr(stop_id,1,instr(stop_id,'-')-1) ELSE stop_id END";
    const statements=[
      this.db.prepare('SELECT * FROM station_schedules WHERE service_date BETWEEN ? AND ?').bind(range.from,range.to),
      this.db.prepare(`SELECT e.* FROM events e WHERE service_date BETWEEN ? AND ? AND ((${code}) IN ('2716','2554','9228','9229','9230') OR EXISTS(SELECT 1 FROM station_schedules s WHERE s.route_id=e.route_id AND s.trip_id=e.trip_id AND s.service_date=e.service_date AND ABS(s.sequence-e.sequence)<=2))`).bind(range.from,range.to),
      this.db.prepare('SELECT * FROM cancellations WHERE service_date BETWEEN ? AND ?').bind(range.from,range.to),
      this.db.prepare('SELECT * FROM routes ORDER BY id'),
      this.db.prepare('SELECT * FROM station_positions WHERE service_date BETWEEN ? AND ? ORDER BY position_time').bind(range.from,range.to),
      this.db.prepare('SELECT * FROM station_predictions WHERE service_date BETWEEN ? AND ?').bind(range.from,range.to)];
    const [schedules,events,cancel,routes,positions,predictions]=(await this.db.batch(statements)).map(r=>r.results);
    return {...Transfers.analyze(schedules,events,cancel,routes,{...filters,positions,predictions}),timetable:await this.getState('timetable'),location:await this.getState('positions'),serviceStatus:await this.getState('adherence')};
  }
  async savePositions(rows){
    const nearby=rows.filter(p=>p.distance<=Positions.station.archiveRadius);if(!nearby.length)return;
    await this.run(`INSERT OR IGNORE INTO station_positions SELECT json_extract(value,'$.route_id'),json_extract(value,'$.trip_id'),json_extract(value,'$.service_date'),json_extract(value,'$.start_time'),json_extract(value,'$.vehicle_id'),json_extract(value,'$.vehicle_label'),json_extract(value,'$.position_time'),json_extract(value,'$.latitude'),json_extract(value,'$.longitude'),json_extract(value,'$.distance'),json_extract(value,'$.progress_sequence') FROM json_each(?)`,JSON.stringify(nearby));
  }
  async saveOccupancy(rows){
    if(!rows.length)return;
    await this.run(`INSERT OR IGNORE INTO occupancy_samples SELECT json_extract(value,'$.route_id'),json_extract(value,'$.trip_id'),json_extract(value,'$.service_date'),json_extract(value,'$.start_time'),json_extract(value,'$.vehicle_id'),json_extract(value,'$.sample_bucket'),json_extract(value,'$.sample_time'),json_extract(value,'$.occupancy_status'),json_extract(value,'$.occupancy_percentage') FROM json_each(?)`,JSON.stringify(rows));
  }
  async occupancy(filters){
    const [groups,trips]=(await this.db.batch(Occupancy.queries(filters).map(q=>this.db.prepare(q.sql).bind(...q.params)))).map(r=>r.results);
    return Occupancy.report(groups,trips,await this.routes(),filters);
  }
  async exportRows(filters){
    const {where,params}=Search.eventSql(filters);return this.all(`SELECT * FROM events WHERE ${where} ORDER BY event_time DESC LIMIT 10001`,...params);
  }
}
