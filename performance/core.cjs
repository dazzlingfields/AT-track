const Trips=require('./trips.cjs');
const Hours=require('./hours.cjs');
const { DatabaseSync } = require('node:sqlite');
const { extract, matches, canonical, dateAt } = require('./feed.cjs');
const Transfers=require('./transfers.cjs');
const Search=require('./search.cjs');
const Retention=require('./retention.cjs');
const Positions=require('./positions.cjs');
const Occupancy=require('./occupancy.cjs');
const Predictions=require('./predictions.cjs');
class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS routes (id INTEGER PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('bus','train')), route_id TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(mode,code));
      CREATE TABLE IF NOT EXISTS events (route_id INTEGER NOT NULL, trip_id TEXT NOT NULL, service_date TEXT NOT NULL,
        start_time TEXT NOT NULL, stop_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL,
        event_time REAL NOT NULL, scheduled_time REAL, delay_sec REAL, reported_at REAL NOT NULL,
        PRIMARY KEY(route_id,trip_id,service_date,start_time,stop_id,sequence,kind));
      CREATE INDEX IF NOT EXISTS event_dates ON events(service_date,route_id,kind);
      CREATE TABLE IF NOT EXISTS cancellations (route_id INTEGER NOT NULL, trip_id TEXT NOT NULL, service_date TEXT NOT NULL,
        start_time TEXT NOT NULL, reported_at REAL NOT NULL, PRIMARY KEY(route_id,trip_id,service_date,start_time));
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS station_schedules (
      route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,stop_id TEXT NOT NULL,stop_code TEXT NOT NULL,
      sequence INTEGER NOT NULL,scheduled_time REAL NOT NULL,destination TEXT NOT NULL,pickup_type INTEGER NOT NULL,seen_at REAL NOT NULL,
      PRIMARY KEY(route_id,trip_id,service_date,stop_code,sequence));
      CREATE INDEX IF NOT EXISTS station_schedule_dates ON station_schedules(service_date,route_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS station_positions (
      route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,start_time TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,vehicle_label TEXT NOT NULL,position_time REAL NOT NULL,
      latitude REAL NOT NULL,longitude REAL NOT NULL,distance REAL NOT NULL,progress_sequence INTEGER,
      PRIMARY KEY(route_id,trip_id,service_date,start_time,vehicle_id,position_time));
      CREATE INDEX IF NOT EXISTS station_position_dates ON station_positions(service_date,route_id);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS occupancy_samples (
      route_id INTEGER NOT NULL,trip_id TEXT NOT NULL,service_date TEXT NOT NULL,start_time TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,sample_bucket INTEGER NOT NULL,sample_time REAL NOT NULL,
      occupancy_status INTEGER,occupancy_percentage REAL,
      PRIMARY KEY(route_id,trip_id,service_date,start_time,vehicle_id,sample_bucket));
      CREATE INDEX IF NOT EXISTS occupancy_dates ON occupancy_samples(service_date,route_id);`);
    this.db.exec(Predictions.schema);this.db.exec(Trips.schema);this.db.exec("CREATE INDEX IF NOT EXISTS trip_events ON events(route_id,service_date,trip_id,start_time)");
    // Seed once, so pausing a default route survives restarts.
    if (!this.getState('initialized')) {
      this.addRoute({ code: '376', name: 'Route 376', mode: 'bus' });
      this.addRoute({ code: 'S-C', name: 'South City', mode: 'train' });
      this.setState('initialized', true);
    }
  }
  routes() { return this.db.prepare('SELECT * FROM routes ORDER BY id').all(); }

  missingTimetables(rows){if(!rows.length)return [];return this.db.prepare("SELECT json_extract(j.value,'$.route_id') route_id,json_extract(j.value,'$.trip_id') trip_id,json_extract(j.value,'$.service_date') service_date FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM trip_timetables t WHERE t.route_id=json_extract(j.value,'$.route_id') AND t.trip_id=json_extract(j.value,'$.trip_id') AND t.service_date=json_extract(j.value,'$.service_date'))").all(JSON.stringify(rows));}
  archiveTimetables(rows){if(rows.length)this.db.prepare(Trips.archiveSql).run(JSON.stringify(rows));}
  tripData({routeId,date,tripId=''}){const read=table=>this.db.prepare('SELECT * FROM '+table+' WHERE route_id=? AND service_date=? AND (? OR trip_id=?)').all(routeId,date,tripId?0:1,tripId);return {archives:read('trip_timetables'),events:read('events'),cancellations:read('cancellations')};}
  purgeHistory(now=Date.now()) {
    const policy=Retention.policy(now),previous=this.getState('retention');
    if(previous?.today===policy.today&&previous?.months===policy.months)return previous;
    this.db.exec('BEGIN');
    try{
      for(const table of Retention.tables)this.db.prepare(`DELETE FROM ${table} WHERE service_date < ?`).run(policy.cutoff);
      this.setState('retention',policy);this.db.exec('COMMIT');return policy;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  addRoute({ code, name, mode, routeId = '' }) {
    code = String(code ?? '').trim().toUpperCase(); name = String(name ?? '').trim(); routeId = String(routeId).trim();
    if (!/^[A-Z0-9][A-Z0-9 -]{0,39}$/.test(code) || !name || name.length > 100 || !['bus', 'train'].includes(mode) || routeId.length > 100) throw Error('Enter a route code, name and bus/train mode');
    if (this.routes().some(r => r.mode === mode && canonical(r.code) === canonical(code))) throw Error('This route is already tracked');
    if (this.routes().length >= 100) throw Error('At most 100 routes can be tracked');
    return this.db.prepare('INSERT INTO routes(code,name,mode,route_id) VALUES(?,?,?,?)').run(code, name, mode, routeId);
  }
  toggle(id, active) { return this.db.prepare('UPDATE routes SET active=? WHERE id=?').run(active ? 1 : 0, id); }
  setState(key, value) { this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, JSON.stringify(value)); }
  getState(key) { const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; }
  ingest(batch) {
    const insert = this.db.prepare(`INSERT INTO events VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET
      event_time=excluded.event_time, scheduled_time=COALESCE(excluded.scheduled_time,events.scheduled_time),
      delay_sec=COALESCE(excluded.delay_sec,events.delay_sec), reported_at=excluded.reported_at
      WHERE excluded.reported_at>events.reported_at`);
    const cancel = this.db.prepare('INSERT INTO cancellations VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET reported_at=MAX(reported_at,excluded.reported_at)');
    this.db.exec('BEGIN');
    try {
      for (const e of batch.events) insert.run(e.routeId,e.tripId,e.serviceDate,e.startTime,e.stopId,e.sequence,e.kind,e.eventTime,e.scheduledTime,e.delaySec,e.reportedAt);
      for (const c of batch.cancellations) cancel.run(c.routeId,c.tripId,c.serviceDate,c.startTime,c.reportedAt);
      for(const q of Predictions.statements(batch))this.db.prepare(q.sql).run(...q.params);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  report({ from, to, routeId = 0, kind = 'arrival', early = 60, late = 300,search='',timeFrom='',timeTo='',page=1 }) {
    const where = 'service_date BETWEEN ? AND ? AND (?=0 OR route_id=?)';
    const params = [from,to,routeId,routeId];
    const events = Search.filterEvents(this.db.prepare(`SELECT * FROM events WHERE ${where} AND kind=? ORDER BY event_time DESC,trip_id,stop_id,sequence`).all(...params,kind),this.routes(),{search,timeFrom,timeTo});
    const cancellations = this.db.prepare(`SELECT * FROM cancellations WHERE ${where}`).all(...params);
    const summary = rows => {
      const known = rows.filter(r => r.delay_sec !== null), onTime = known.filter(r => r.delay_sec >= -early && r.delay_sec <= late).length;
      return { observations: rows.length, measured: known.length, unknown: rows.length-known.length, onTime,
        early: known.filter(r => r.delay_sec < -early).length, late: known.filter(r => r.delay_sec > late).length,
        onTimePercent: known.length ? onTime / known.length * 100 : null,
        averageDelay: known.length ? known.reduce((sum,r) => sum+r.delay_sec,0) / known.length : null,
        trips: new Set(rows.map(r => `${r.route_id}|${r.trip_id}|${r.service_date}|${r.start_time}`)).size };
    };
    const dates = [...new Set(events.map(r => r.service_date))].sort();
    return { from,to,routeId,kind,early,late,page,pageSize:200,search,timeFrom,timeTo,hourly:Hours.route(events,early,late),extremes:Search.dailyExtremes(events).map(d=>({...d,late:d.late.map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)})),early:d.early.map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)}))})),summary: { ...summary(events), cancellations: cancellations.length },
      routes: this.routes().map(r => ({ ...r,...summary(events.filter(e => e.route_id === r.id)),
        cancellations: cancellations.filter(c => c.route_id === r.id).length })),
      daily: dates.map(date => ({ date,...summary(events.filter(r => r.service_date === date)) })),
      stops:[...new Set(events.map(e=>JSON.stringify([e.route_id,Transfers.stopCode(e.stop_id)])))].map(key=>{
        const [route_id,stop_code]=JSON.parse(key),rows=events.filter(e=>e.route_id===route_id&&Transfers.stopCode(e.stop_id)===stop_code),known=rows.filter(r=>r.delay_sec!==null);
        return {route_id,stop_code,stop_name:Transfers.stopName(stop_code),...summary(rows),ahead:known.filter(r=>r.delay_sec<0).length,
          behind:known.filter(r=>r.delay_sec>0).length,earliest:known.length?Math.min(...known.map(r=>r.delay_sec)):null,latest:known.length?Math.max(...known.map(r=>r.delay_sec)):null};
      }),events: events.slice((page-1)*200,page*200).map(e=>({...e,stop_name:Transfers.stopName(e.stop_id)})), totalEvents: events.length };
  }
  saveSchedules(rows){
    const insert=this.db.prepare(`INSERT INTO station_schedules VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET scheduled_time=excluded.scheduled_time,destination=excluded.destination,pickup_type=excluded.pickup_type,seen_at=excluded.seen_at`);
    this.db.exec('BEGIN');try{for(const r of rows)insert.run(r.route_id,r.trip_id,r.service_date,r.stop_id,r.stop_code,r.sequence,r.scheduled_time,r.destination,r.pickup_type,r.seen_at);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  savePositions(rows){
    const insert=this.db.prepare('INSERT OR IGNORE INTO station_positions VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    this.db.exec('BEGIN');try{for(const p of rows.filter(p=>p.distance<=Positions.station.archiveRadius))insert.run(p.route_id,p.trip_id,p.service_date,p.start_time,p.vehicle_id,p.vehicle_label,p.position_time,p.latitude,p.longitude,p.distance,p.progress_sequence??null);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  saveOccupancy(rows){
    const insert=this.db.prepare('INSERT OR IGNORE INTO occupancy_samples VALUES(?,?,?,?,?,?,?,?,?)');
    this.db.exec('BEGIN');try{for(const p of rows)insert.run(p.route_id,p.trip_id,p.service_date,p.start_time,p.vehicle_id,p.sample_bucket,p.sample_time,p.occupancy_status,p.occupancy_percentage);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  occupancy(filters){const [groups,trips]=Occupancy.queries(filters).map(q=>this.db.prepare(q.sql).all(...q.params));return Occupancy.report(groups,trips,this.routes(),filters);}
  transfers(filters){
    const range=Transfers.bounds(filters.from,filters.to),params=[range.from,range.to];
    const schedules=this.db.prepare('SELECT * FROM station_schedules WHERE service_date BETWEEN ? AND ?').all(...params);
    const events=this.db.prepare('SELECT * FROM events WHERE service_date BETWEEN ? AND ?').all(...params);
    const cancel=this.db.prepare('SELECT * FROM cancellations WHERE service_date BETWEEN ? AND ?').all(...params);
    const positions=this.db.prepare('SELECT * FROM station_positions WHERE service_date BETWEEN ? AND ?').all(...params);
    const predictions=this.db.prepare('SELECT * FROM station_predictions WHERE service_date BETWEEN ? AND ?').all(...params);
    return {...Transfers.analyze(schedules,events,cancel,this.routes(),{...filters,positions,predictions}),timetable:this.getState('timetable'),location:this.getState('positions'),serviceStatus:this.getState('adherence')};
  }
  close() { this.db.close(); }
}
module.exports = { Store, extract, matches, canonical, dateAt };
