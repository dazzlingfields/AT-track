const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {Store,extract,matches,dateAt}=require('../performance/core.cjs');
const {Collector}=require('../performance/collector.cjs');
const {createServer,options,csvCell}=require('../performance/server.cjs');
const now=Date.parse('2026-10-06T23:00:00Z')/1000;
const metadata=new Map([['376-202',{route_short_name:'376',route_type:3}],['S-C-202',{route_short_name:'S-C',route_type:2}],['E-W-202',{route_short_name:'E-W',route_type:2}]]);
const update=(extra={})=>({trip:{trip_id:'trip',route_id:'376-202',start_date:'20261007'},timestamp:now,
  stop_time_update:{stop_id:'1000-hash',stop_sequence:1,arrival:{time:now-10,delay:90},departure:{time:now-5,delay:100}},...extra});
const feed=(updates=[update()])=>({response:{header:{timestamp:now},entity:updates.map(trip_update=>({trip_update}))}});
const filters={from:'2026-10-07',to:'2026-10-07',routeId:0,kind:'arrival',early:60,late:300};
test('hourly route charts include all filtered history, scheduled clock hours, unknown delays and overnight services with local/D1 parity',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:'),S=require('../schedule-data.js');
 const base=S.timeEpoch('17:00:00','2026-10-07'),delays=[-61,-60,300,301,null];
 const events=Array.from({length:240},(_,i)=>({routeId:1,tripId:'hour-'+i,serviceDate:'2026-10-07',startTime:'',stopId:'2716',sequence:1,kind:'arrival',eventTime:base+3600+i,scheduledTime:base+i,delaySec:delays[i%5],reportedAt:now}));
 events.push({...events[0],tripId:'overnight',eventTime:base+7*3600+20,scheduledTime:base+7*3600,delaySec:20});
 try{for(const store of [local,cloud])await store.ingest({events,cancellations:[]});const a=local.report(filters),b=await cloud.report(filters);assert.deepEqual(a.hourly,b.hourly);assert.equal(b.events.length,200);assert.equal(b.hourly[17].observations,240);assert.equal(b.hourly[17].measured,192);assert.equal(b.hourly[17].onTime,96);assert.equal(b.hourly[17].unknown,48);assert.equal(b.hourly[17].early,48);assert.equal(b.hourly[17].late,48);assert.equal(b.hourly[0].measured,1);assert.equal(b.hourly[18].measured,0);assert.equal(b.hourly[18].averageDelay,null);
 const narrowed={...filters,search:'hour-1'};assert.deepEqual(local.report(narrowed).hourly,(await cloud.report(narrowed)).hourly);
 }finally{local.close();db.close();}
});
test('cloud hourly aggregation preserves the daylight-saving gap and time filters',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
 const events=['2026-09-26T13:30:00Z','2026-09-26T14:30:00Z'].map((time,i)=>({routeId:1,tripId:'dst-'+i,serviceDate:'2026-09-27',startTime:'',stopId:'2716',sequence:1,kind:'arrival',eventTime:Date.parse(time)/1000,scheduledTime:Date.parse(time)/1000,delaySec:i*60,reportedAt:now}));
 try{for(const store of [local,cloud])await store.ingest({events,cancellations:[]});for(const extra of [{},{timeFrom:'03:00',timeTo:'03:59'}]){
  const selected={...filters,from:'2026-09-27',to:'2026-09-27',...extra},report=await cloud.report(selected);assert.deepEqual(report.hourly,local.report(selected).hourly);assert.equal(report.hourly[2].observations,0);assert.equal(report.hourly[3].observations,1);assert.equal(report.hourly[1].observations,extra.timeFrom?0:1);
 }}finally{local.close();db.close();}
});
test('hourly charts use Auckland daylight-saving offsets and keep transfer estimates, missing evidence and direction anchors distinct',()=>{
 const H=require('../performance/hours.cjs'),S=require('../schedule-data.js'),base=S.timeEpoch('17:00:00','2026-10-07');
 const cases=['2026-09-26T13:30:00Z','2026-09-26T14:30:00Z'].map((time,i)=>({event_time:Date.parse(time)/1000,scheduled_time:null,delay_sec:i*60,route_id:1,trip_id:String(i),service_date:'2026-09-27',start_time:''}));const hours=H.route(cases,60,300);assert.equal(hours[1].observations,1);assert.equal(hours[3].observations,1);assert.equal(hours[2].observations,0);
 const pairs=['possible','missed','estimated-possible','estimated-missed','unknown','pending','cancelled','estimated-uncertain'].map(status=>({scheduledBus:base,scheduledTrain:base+3600,status}));const forward=H.transfers(pairs,'bus-train'),reverse=H.transfers(pairs,'train-bus');assert.equal(forward[17].total,8);assert.equal(forward[17].possible,1);assert.equal(forward[17].estimatedPossible,1);assert.equal(forward[17].unknown,1);assert.equal(forward[17].close,1);assert.equal(reverse[18].total,8);
});
test('durable collector alarms survive errors, honour backoff and watchdog calls preserve an existing alarm',async()=>{
 const {collectorClass}=await import('../performance/cloud/alarm-collector.mjs');let now=100000,next=null,samples=0;
 const ctx={storage:{async getAlarm(){return next;},async setAlarm(value){next=value;}}};
 const Class=collectorClass(async()=>{samples++;now+=3000;return {retryAt:now+60000};},async()=>{},()=>now),collector=new Class(ctx,{});
 await collector.fetch();assert.equal(next,101000);await collector.fetch();assert.equal(next,101000);
 await collector.alarm();assert.equal(samples,1);assert.equal(next,163000);assert.equal(collector.running,false);
 const Fail=collectorClass(async()=>{throw Error('Network failure');},async()=>{},()=>now),failure=new Fail(ctx,{});await assert.rejects(failure.alarm(),/Network/);assert.equal(next,now+20000);assert.equal(failure.running,false);
 next=now-60001;await collector.fetch();assert.equal(next,now+1000);
});
test('compact feed decoder retains tracked stop and vehicle entities, quoted braces and suffixes, with a safe fallback for other layouts',()=>{
 const Compact=require('../performance/compact-feed.cjs'),store=new Store(':memory:');
 const entities=[{id:'other',trip_update:update({trip:{trip_id:'unrelated',route_id:'70-202'}})},{id:'tracked',trip_update:update({vehicle:{id:'bus',label:'Quoted " } {'}})},{id:'position',vehicle:{trip:{route_id:'376-202',trip_id:'trip'},vehicle:{id:'bus'}}}];
 const payload={response:{header:{timestamp:now},entity:entities}};const decoded=Compact.decode(JSON.stringify(payload),store.routes(),metadata);assert.deepEqual(decoded.entity,entities.slice(1));assert.equal(extract(decoded,store.routes(),metadata,now).events.length,2);
 assert.deepEqual(Compact.decode(JSON.stringify(payload,null,2),store.routes(),metadata),payload);
 const alternate={header:{timestamp:now},entity:[{trip_update:update(),id:'after-trip'}]};assert.deepEqual(Compact.decode(JSON.stringify(alternate),store.routes(),metadata),alternate);
 store.close();
});
function tripFixture(){return {source:'official GTFS',generatedAt:'2026-10-07',feed:{feed_version:'v1',feed_end_date:'20261231'},calendar:[{service_id:'wk',start_date:'20260901',end_date:'20261231',monday:'1',tuesday:'1',wednesday:'1',thursday:'1',friday:'1',saturday:'0',sunday:'0'}],exceptions:[{service_id:'wk',date:'20261008',exception_type:'2'},{service_id:'wk',date:'20261010',exception_type:'1'}],stops:{'2716-abcdef12':'Papakura Station','other':'Drury'},trips:[{id:'loop',service:'wk',destination:'Drury loop',direction:0,stops:[[1,'2716-abcdef12',36000,36030,0,0],[2,'other',36500,36500,0,0],[3,'2716-abcdef12',37000,37060,0,0]]},{id:'scheduled',service:'wk',destination:'Later service',direction:0,stops:[[1,'other',40000,40030,0,0]]}]};}
test('trip calendars include exceptions, exclude inactive days, and preserve separate scheduled arrival/departure',()=>{
 const Trips=require('../performance/trips.cjs'),data=tripFixture();assert.equal(Trips.active(data,'wk','2026-10-07'),true);assert.equal(Trips.active(data,'wk','2026-10-08'),false);assert.equal(Trips.active(data,'wk','2026-10-10'),true);assert.equal(Trips.active(data,'wk','2026-10-11'),false);
 const row=Trips.timetable(data,'loop','2026-10-07',1),stops=JSON.parse(row.stops_json);assert.equal(stops.length,3);assert.equal(stops[0].scheduledDeparture-stops[0].scheduledArrival,30);assert.equal(stops[2].sequence,3);assert.equal(Trips.timetable(data,'loop','2026-10-08',1),null);
 assert.throws(()=>Trips.options(new URL('https://tracker/api/trips?route=1&date=2026-02-30')),/valid/);
});
test('trip timeline keeps loop visits, trip instances, corrections, early/late signs and missing stop reports separate',()=>{
 const Trips=require('../performance/trips.cjs'),archive=Trips.timetable(tripFixture(),'loop','2026-10-07',1),planned=JSON.parse(archive.stops_json),selection={routeId:1,date:'2026-10-07',tripId:'loop',startTime:'10:00:00'};
 const event=(sequence,kind,time,delay,start='10:00:00')=>({route_id:1,trip_id:'loop',service_date:selection.date,start_time:start,stop_id:'2716-12345678',sequence,kind,event_time:time,delay_sec:delay,reported_at:now});
 const events=[event(1,'arrival',planned[0].scheduledArrival-30,-30),event(1,'departure',planned[0].scheduledDeparture,0),event(3,'arrival',planned[2].scheduledArrival+120,120),event(1,'arrival',planned[0].scheduledArrival+900,900,'10:30:00')];
 let detail=Trips.detail(archive,events,false,selection,now);assert.equal(detail.stops.length,3);assert.equal(detail.stops[0].arrival.delay,-30);assert.equal(detail.stops[0].departure.delay,0);assert.equal(detail.stops[0].dwellSeconds,60);assert.equal(detail.stops[1].arrival.status,'Not captured');assert.equal(detail.stops[2].arrival.delay,120);assert.equal(detail.summary.arrivals,2);
 const correction={...events[0],event_time:planned[0].scheduledArrival-10,delay_sec:-10,reported_at:now+1};detail=Trips.detail(archive,[...events,correction],false,selection,now);assert.equal(detail.stops[0].arrival.delay,-10);
 assert.equal(Trips.detail(archive,[],false,selection,planned[0].scheduledArrival-60).stops[0].arrival.status,'Pending');assert.equal(Trips.detail(archive,[],true,selection).stops[0].arrival.status,'Cancelled');
});
test('trip explorer lists scheduled services without implying observations and freezes archived timetable versions in local and D1',async()=>{
 const Trips=require('../performance/trips.cjs'),data=tripFixture(),{CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:'),selection={routeId:1,date:'2026-10-07',tripId:'loop',startTime:'10:00:00'};
 try{for(const [store,database] of [[local,local.db],[cloud,db]]){
  await store.ingest({events:[{routeId:1,tripId:'loop',serviceDate:selection.date,startTime:selection.startTime,stopId:'2716-abcdef12',sequence:1,kind:'arrival',eventTime:now-10,delaySec:0,scheduledTime:now-10,reportedAt:now}],cancellations:[]});
  const batch={events:[],adherence:[{routeId:1,tripId:'loop',serviceDate:selection.date}],cancellations:[]};assert.equal(await Trips.sync(store,await store.routes(),batch,async()=>data),1);assert.equal(await Trips.sync(store,await store.routes(),batch,async()=>{throw Error('Should not reload unchanged timetable');}),0);
  const changed=tripFixture();changed.trips[0].stops[0][2]+=999;await store.archiveTimetables([Trips.timetable(changed,'loop',selection.date,1)]);
  const detail=await Trips.view(store,selection,async()=>changed);assert.equal(detail.stops[0].arrival.scheduled,JSON.parse(Trips.timetable(data,'loop',selection.date,1).stops_json)[0].scheduledArrival);
  const listed=await Trips.view(store,{...selection,tripId:''},async()=>data);assert.equal(listed.trips.length,2);assert.equal(listed.trips.find(t=>t.tripId==='scheduled').observations,0);assert.equal(listed.trips.find(t=>t.tripId==='loop').startTime,selection.startTime);
  await store.archiveTimetables([{...Trips.timetable(data,'loop',selection.date,1),service_date:'2026-06-01'}]);await store.purgeHistory(now*1000);assert.equal(database.prepare('SELECT COUNT(*) n FROM trip_timetables').get().n,1);
 }assert.deepEqual(await Trips.view(local,selection,async()=>null),await Trips.view(cloud,selection,async()=>null));}finally{local.close();db.close();}
});
test('station forecasts remain forecasts until later stop progress, and fresh zero-uncertainty reports survive timestamp lag',()=>{
 const store=new Store(':memory:');
 const station=(time,uncertainty)=>update({timestamp:now-20,stop_time_update:{stop_id:'2716-29bbacfe',stop_sequence:31,departure:{time,delay:40,uncertainty}}});
 let batch=extract(feed([station(now-10,30)]),store.routes(),metadata,now);
 assert.equal(batch.events.length,0);assert.equal(batch.predictions.length,1);assert.equal(batch.progress.length,0);
 assert.equal(extract(feed([station(now-10,0)]),store.routes(),metadata,now).events.length,1);
 assert.equal(extract(feed([station(now+10,0)]),store.routes(),metadata,now).events.length,0);
 const old=station(now-310,0);old.timestamp=now-300;
 assert.equal(extract(feed([old]),store.routes(),metadata,now).events.length,1);
 old.stop_time_update.departure.time=now-290;
 assert.equal(extract(feed([old]),store.routes(),metadata,now).events.length,0);
 store.close();
});
test('remembered station forecasts freeze only on matching later progress, update uncertainty and obey retention in both stores',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
 const prediction={routeId:1,tripId:'b',serviceDate:'2026-10-07',startTime:'12:00:00',stopId:'2716',sequence:31,kind:'arrival',eventTime:now-150,delaySec:20,uncertainty:30,reportedAt:now-180,capturedAt:now-180};
 const progress={routeId:1,tripId:'b',serviceDate:'2026-10-07',startTime:'12:00:00',sequence:32,eventTime:now-100};
 try{for(const [store,database] of [[local,local.db],[cloud,db]]){
  const ingest=changes=>store.ingest({events:[],cancellations:[],...changes});
  await ingest({predictions:[prediction]});await ingest({predictions:[{...prediction,uncertainty:75,reportedAt:now-170}]});
  assert.equal(database.prepare('SELECT uncertainty FROM station_predictions').get().uncertainty,75);
  await ingest({progress:[{...progress,sequence:30},{...progress,serviceDate:'2026-10-08'},{...progress,startTime:'13:00:00'}]});
  assert.equal(database.prepare('SELECT passed_at FROM station_predictions').get().passed_at,null);
  await ingest({progress:[progress]});await ingest({predictions:[{...prediction,eventTime:now-80,reportedAt:now-70}]});
  const row=database.prepare('SELECT * FROM station_predictions').get();assert.equal(row.passed_at,now-100);assert.equal(row.event_time,now-150);
  await ingest({invalidStops:[{...progress,sequence:31}]});assert.equal(database.prepare('SELECT invalid FROM station_predictions').get().invalid,1);
  await ingest({predictions:[{...prediction,serviceDate:'2026-06-01'}]});await store.purgeHistory(now*1000);assert.equal(database.prepare('SELECT COUNT(*) n FROM station_predictions').get().n,1);
 }}finally{local.close();db.close();}
});
test('Papakura platform 2 supplies the earlier intended city train; nearby timing stays an estimate and future connections are pending',()=>{
 const X=require('../performance/transfers.cjs'),{t,schedules,routes}=gpsFixtures();
 assert.ok(X.timetableIds.includes('9229-e27fe938'));
 const platform2={...schedules[2],trip_id:'earlier',stop_id:'9229-e27fe938',scheduled_time:t+180};
 const later={...schedules[2],scheduled_time:t+600};
 const stationRows=[...schedules.slice(0,2),platform2,later];
 let report=X.analyze(stationRows,[],[],routes,{...filters,now});assert.equal(report.pairs[0].trainTrip,'earlier');
 const busAfter={...schedules[1],stop_id:'next',sequence:32,kind:'arrival',event_time:t+60,delay_sec:0,reported_at:now,start_time:''};
 const departure={...platform2,kind:'departure',event_time:t+180,delay_sec:0,reported_at:now,start_time:''};
 report=X.analyze(stationRows,[busAfter,departure],[],routes,{...filters,now});assert.equal(report.summary.estimatedPossible,1);assert.equal(report.summary.measured,0);
 departure.event_time=t+120;report=X.analyze(stationRows,[busAfter,departure],[],routes,{...filters,now});assert.equal(report.summary.estimatedUncertain,1);
 report=X.analyze(stationRows,[],[],routes,{...filters,now:t+100});assert.equal(report.summary.pending,1);assert.equal(report.summary.unknown,0);
});
function sqliteD1(){
  const db=new DatabaseSync(':memory:');const dir=path.join(__dirname,'../performance/cloud/migrations');for(const file of fs.readdirSync(dir).sort())db.exec(fs.readFileSync(path.join(dir,file),'utf8'));
  const wrapper={prepare(sql){const statement=db.prepare(sql);return {args:[],bind(...args){this.args=args;return this;},async all(){return {results:statement.all(...this.args)};},async first(){return statement.get(...this.args)||null;},async run(){return {meta:{changes:Number(statement.run(...this.args).changes)}};}};},
    async batch(statements){db.exec('BEGIN');try{const results=[];for(const s of statements){try{results.push(await s.all());}catch{results.push(await s.run());}}db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}};
  return {db,wrapper};
}
test('default routes match bus 376 and South City only, including versioned IDs',()=>{
  const store=new Store(':memory:'),[bus,train]=store.routes();
  assert.equal(matches(bus,{route_id:'376-202'},metadata.get('376-202')),true);
  assert.equal(matches(bus,{route_id:'1376-202'}),false);
  assert.equal(matches(train,{route_id:'S-C-202'}),true);
  assert.equal(matches(train,{route_id:'E-W-202'},metadata.get('E-W-202')),false);
  assert.equal(matches(bus,{route_id:'376-202'},{route_short_name:'376',route_type:2}),false);
  store.close();
});
test('object and list formats record only past observed arrivals/departures',()=>{
  const store=new Store(':memory:');
  const result=extract(feed(),store.routes(),metadata,now);assert.equal(result.events.length,2);assert.equal(result.events[0].delaySec,90);
  const future=update({stop_time_update:[{stop_id:'a',stop_sequence:2,arrival:{time:now+90,delay:90}},{stop_id:'b',stop_sequence:3,arrival:{delay:400}},{stop_id:'c',stop_sequence:4,schedule_relationship:1,arrival:{time:now-1,delay:0}}]});
  assert.equal(extract({entity:{trip_update:future},header:{timestamp:now}},store.routes(),metadata,now).events.length,0);store.close();
});
test('stale feeds fail, missing trip timestamps use fresh header, stale trips are ignored',()=>{
  const store=new Store(':memory:');const f=feed();f.response.header.timestamp=now-121;
  assert.throws(()=>extract(f,store.routes(),metadata,now),/stale/);
  assert.equal(extract(feed([update({timestamp:now-121})]),store.routes(),metadata,now).events.length,0);
  assert.equal(extract(feed([update({timestamp:undefined})]),store.routes(),metadata,now).events.length,2);
  assert.throws(()=>extract({},store.routes(),metadata,now),/entity/);store.close();
});
test('deduplication, corrections, unknown delays and cancelled trips have truthful denominators',()=>{
  const store=new Store(':memory:');const batch=extract(feed(),store.routes(),metadata,now);store.ingest(batch);store.ingest(batch);
  assert.equal(store.report(filters).summary.observations,1);
  const rows=[-61,-60,0,300,301,null].map((delaySec,i)=>({...batch.events[0],tripId:`case${i}`,delaySec}));
  store.ingest({events:rows,cancellations:[]});
  const cancelled=update({trip:{trip_id:'cancel',route_id:'376-202',start_date:'20261007',schedule_relationship:3}});
  store.ingest(extract(feed([cancelled,cancelled]),store.routes(),metadata,now));
  const report=store.report(filters);assert.equal(report.summary.measured,6);assert.equal(report.summary.unknown,1);
  assert.equal(report.summary.onTime,4);assert.equal(report.summary.early,1);assert.equal(report.summary.late,1);assert.equal(report.summary.cancellations,1);
  store.ingest({events:[{...batch.events[0],delaySec:600,reportedAt:now+10}],cancellations:[]});
  assert.equal(store.report(filters).summary.late,2);store.close();
});
test('database history and paused routes survive restart; added routes validate duplicates',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'at-performance-')),filename=path.join(dir,'test.sqlite');let store=new Store(filename);
  store.ingest(extract(feed(),store.routes(),metadata,now));store.toggle(1,false);store.addRoute({code:'70',name:'Route 70',mode:'bus'});store.close();
  store=new Store(filename);assert.equal(store.routes().length,3);assert.equal(store.routes()[0].active,0);assert.equal(store.report(filters).summary.observations,1);
  assert.equal(extract(feed(),store.routes(),metadata,now).events.length,0);assert.throws(()=>store.addRoute({code:'s c',name:'Duplicate',mode:'train'}),/already/);
  store.close();fs.rmSync(dir,{recursive:true});
});
test('filters use Auckland date and reject invalid input; CSV neutralizes formulas',()=>{
  assert.equal(dateAt(now),'2026-10-07');assert.throws(()=>options(new URL('http://localhost/?from=2026-02-30')),/date range/);
  assert.throws(()=>options(new URL('http://localhost/?early=NaN')),/Invalid/);assert.equal(csvCell('=SUM(A1)'),`"'=SUM(A1)"`);
});
test('collector respects rate limits, stale proxy fallback and writes no fabricated history',async()=>{
  const store=new Store(':memory:');let calls=0;
  const collector=new Collector(store,{key:'test',fetcher:async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'60'}});}});
  await collector.poll();await collector.poll();assert.equal(calls,1);assert.match(collector.status.error,/429/);assert.equal(store.report(filters).summary.observations,0);
  const stale=new Collector(store,{proxy:'https://example.test',fetcher:async()=>new Response('{}',{headers:{'x-cache':'stale-hit'}})});
  await stale.poll();assert.match(stale.status.error,/stale/);store.close();
});
test('local API serves dashboard, route mutations, history and export with write protections',async()=>{
  const store=new Store(':memory:');store.ingest(extract(feed(),store.routes(),metadata,now));const collector=new Collector(store,{key:''});
  const server=createServer(store,collector);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base)).status,200);
    const report=await (await fetch(base+'/api/report?from=2026-10-07&to=2026-10-07')).json();assert.equal(report.summary.observations,1);
    const create=await fetch(base+'/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'70',name:'Seventy',mode:'bus'})});assert.equal(create.status,201);
    const blocked=await fetch(base+'/api/routes/1',{method:'PATCH',headers:{'Content-Type':'application/json',Origin:'https://evil.test'},body:'{"active":false}'});assert.equal(blocked.status,403);
    const csv=await (await fetch(base+'/api/export?from=2026-10-07&to=2026-10-07')).text();assert.match(csv,/trip_id/);assert.match(csv,/376/);
    assert.equal((await fetch(base+'/api/report?late=nope')).status,400);
  }finally{await new Promise(r=>server.close(r));store.close();}
});
test('D1 migration and ingestion SQL work; unchanged polling causes no new writes; reports match local results',async()=>{
  const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
  try{
    const batch=extract(feed(),local.routes(),metadata,now);await cloud.ingest(batch);local.ingest(batch);
    await cloud.ingest({...batch,events:batch.events.map(e=>({...e,reportedAt:now+30}))});assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,2);
    assert.equal(db.prepare('SELECT reported_at FROM events LIMIT 1').get().reported_at,now);
    assert.deepEqual((await cloud.report(filters)).summary,local.report(filters).summary);
    await cloud.ingest({events:[{...batch.events[0],delaySec:600,reportedAt:now+60}],cancellations:batch.cancellations});assert.equal((await cloud.report(filters)).summary.late,1);
    await cloud.addRoute({code:'70',name:'Seventy',mode:'bus'});assert.equal((await cloud.routes()).length,3);
    const paused=await cloud.toggle(1,false);assert.equal(paused.meta.changes,1);
  }finally{db.close();local.close();}
});
test('cloud dashboard requires authentication and scheduled collector stores errors and honours its lease',async()=>{
  const worker=await import('../performance/cloud/worker.mjs'),{db,wrapper}=sqliteD1(),env={DB:wrapper,DASHBOARD_PASSWORD:'test-password',ASSETS:{fetch:async()=>new Response('dashboard')}};
  try{
    assert.equal((await worker.default.fetch(new Request('https://example.test'),env)).status,401);
    const headers={Authorization:'Basic '+Buffer.from('admin:test-password').toString('base64')};
    assert.equal((await worker.default.fetch(new Request('https://example.test',{headers}),env)).status,200);
    await worker.collect(env,now*1000);const state=JSON.parse(db.prepare("SELECT value FROM state WHERE key='collector'").get().value);assert.match(state.error,/AT_API_KEY/);assert.equal(state.configured,false);
    assert.equal(db.prepare("SELECT value FROM state WHERE key='lease'").get().value,'0');
    db.prepare("UPDATE state SET value=? WHERE key='lease'").run(String(now*1000+55000));await worker.collect(env,now*1000);assert.equal(db.prepare("SELECT value FROM state WHERE key='lease'").get().value,String(now*1000+55000));
  }finally{db.close();}
});
test('cloud scheduled collection persists a fresh feed and records a successful checkpoint',async()=>{
  const worker=await import('../performance/cloud/worker.mjs'),{db,wrapper}=sqliteD1(),originalFetch=global.fetch;
  const stamp=Math.floor(Date.now()/1000),payload=feed([update({timestamp:stamp,stop_time_update:{stop_id:'1000',stop_sequence:1,arrival:{time:stamp-5,delay:90}}})]);payload.response.header.timestamp=stamp;
  let calls=0;global.fetch=async url=>{if(/\/(routes|tripupdates|legacy)$/.test(String(url)))calls++;return new Response(JSON.stringify(String(url).endsWith('/routes')?{data:[...metadata].map(([id,attributes])=>({id,attributes}))}:payload));};
  try{
    db.exec("CREATE TABLE checkpoints(running INTEGER); CREATE TRIGGER checkpoint_insert AFTER INSERT ON state WHEN new.key='collector' BEGIN INSERT INTO checkpoints VALUES(json_extract(new.value,'$.running')); END; CREATE TRIGGER checkpoint_update AFTER UPDATE ON state WHEN new.key='collector' BEGIN INSERT INTO checkpoints VALUES(json_extract(new.value,'$.running')); END;");
    await worker.collect({DB:wrapper,AT_API_KEY:'fixture'},stamp*1000);
    const state=JSON.parse(db.prepare("SELECT value FROM state WHERE key='collector'").get().value);
    assert.equal(state.error,null);assert.ok(state.lastSuccess);assert.equal(state.lastBatch.events,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,1);
    const leaseRow=db.prepare("SELECT rowid FROM state WHERE key='lease'").get().rowid;
    await worker.collect({DB:wrapper,AT_API_KEY:'fixture'},stamp*1000+1000);assert.equal(calls,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n,1);
    assert.equal(db.prepare("SELECT rowid FROM state WHERE key='lease'").get().rowid,leaseRow);assert.equal(db.prepare("SELECT value FROM state WHERE key='lease'").get().value,'0');
    assert.deepEqual(db.prepare('SELECT running FROM checkpoints').all().map(r=>r.running),[1,0,1,0]);
  }finally{global.fetch=originalFetch;db.close();}
});
test('per-stop results group changing suffixes and show signed early/late counts separately from tolerance',async()=>{
  const store=new Store(':memory:'),batch=extract(feed(),store.routes(),metadata,now);
  store.ingest({events:[{...batch.events[0],stopId:'2716-abcdef12',tripId:'a',delaySec:-30},{...batch.events[0],stopId:'2716-12345678',tripId:'b',delaySec:30}],cancellations:[]});
  const stop=store.report(filters).stops[0];assert.equal(stop.stop_name,'Papakura Station');assert.equal(stop.measured,2);assert.equal(stop.ahead,1);assert.equal(stop.behind,1);assert.equal(stop.onTimePercent,100);store.close();
  assert.equal(require('../performance/transfers.cjs').stopName('9230-abcdef12'),'Papakura Train Station 3');
});
test('Papakura return uses the second visit and intended city train; a later train cannot hide a miss',()=>{
  const X=require('../performance/transfers.cjs'),t=now-1000,routeRows=[{id:1,code:'376',mode:'bus'},{id:2,code:'S-C',mode:'train'}];
  const schedule=(route_id,trip_id,sequence,scheduled_time,destination='City Centre via Grafton')=>({route_id,trip_id,sequence,scheduled_time,destination,service_date:'2026-10-07',stop_id:route_id===1?'2716-abcdef12':'9230-abcdef12',pickup_type:0});
  const schedules=[schedule(1,'bus',3,t-1600,'Drury'),schedule(1,'bus',31,t,'Papakura'),schedule(2,'intended',4,t+120),schedule(2,'later',4,t+1020),{...schedule(2,'south',20,t+10,'Pukekohe'),stop_id:'9228-abcdef12'}];
  const event=(s,kind,time,delay)=>({...s,kind,event_time:time,scheduled_time:s.scheduled_time,delay_sec:delay,reported_at:now,start_time:''});
  const events=[event(schedules[0],'arrival',t-1600,0),event(schedules[1],'arrival',t+90,90),event(schedules[2],'arrival',t+100,-20),event(schedules[2],'departure',t+130,10),event(schedules[3],'departure',t+1020,0)];
  let report=X.analyze(schedules,events,[],routeRows,{...filters,walk:120,direction:'city',now});
  assert.equal(report.pairs.length,1);assert.equal(report.pairs[0].busSequence,31);assert.equal(report.pairs[0].trainTrip,'intended');assert.equal(report.summary.missed,1);assert.equal(report.summary.successPercent,0);
  events[1].event_time=t+30;report=X.analyze(schedules,events,[],routeRows,{...filters,walk:60,direction:'city',now});assert.equal(report.summary.possible,1);
  report=X.analyze(schedules,events.filter(e=>e.kind!=='departure'||e.trip_id!=='intended'),[],routeRows,{...filters,walk:120,now});assert.equal(report.summary.unknown,1);assert.equal(report.summary.measured,0);
  report=X.analyze(schedules,events,[{route_id:2,trip_id:'intended',service_date:'2026-10-07'}],routeRows,{...filters,now});assert.equal(report.summary.cancelled,1);assert.equal(report.summary.measured,0);
  assert.throws(()=>X.transferOptions(new URL('https://example.test?walk=59')),/1–30/);
  assert.equal(X.transferOptions(new URL('https://example.test')).walk,120);
});
test('a lone station visit, duplicate sequence or departure-only bus event cannot fabricate a successful transfer',()=>{
  const X=require('../performance/transfers.cjs'),routes=[{id:1,code:'376',mode:'bus'},{id:2,code:'S-C',mode:'train'}];
  const row={route_id:1,trip_id:'bus',service_date:'2026-10-07',stop_id:'2716-abcdef12',sequence:31,scheduled_time:now-300,destination:'Papakura',pickup_type:0};
  const report=X.analyze([row,row],[],[],routes,{...filters,now});assert.equal(report.summary.returnVisits,0);assert.equal(report.summary.unclassifiedVisits,1);
});
test('D1 and local archives persist both 376 visits and produce identical transfer results',async()=>{
  const X=require('../performance/transfers.cjs'),{CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
  const schedules=X.scheduleRows({data:[{tripId:'bus',serviceDate:'2026-10-07',stopId:'2716-abcdef12',sequence:3,routeId:'376-203',scheduledTime:now-2000,destination:'Drury'},
    {tripId:'bus',serviceDate:'2026-10-07',stopId:'2716-abcdef12',sequence:31,routeId:'376-203',scheduledTime:now-400,destination:'Papakura'},
    {tripId:'train',serviceDate:'2026-10-07',stopId:'9230-abcdef12',sequence:4,routeId:'S-C-201',scheduledTime:now-280,destination:'City Centre via Grafton'}]},local.routes(),now);
  const batch={events:[{routeId:1,tripId:'bus',serviceDate:'2026-10-07',startTime:'',stopId:'2716-abcdef12',sequence:31,kind:'arrival',eventTime:now-400,scheduledTime:now-400,delaySec:0,reportedAt:now},
    {routeId:2,tripId:'train',serviceDate:'2026-10-07',startTime:'',stopId:'9230-abcdef12',sequence:4,kind:'departure',eventTime:now-280,scheduledTime:now-280,delaySec:0,reportedAt:now}],cancellations:[]};
  try{
    local.saveSchedules(schedules);await cloud.saveSchedules(schedules);await cloud.saveSchedules(schedules);
    local.ingest(batch);await cloud.ingest(batch);
    const opts={...filters,walk:120,direction:'city'};assert.deepEqual((await cloud.transfers(opts)).summary,local.transfers(opts).summary);assert.equal(local.transfers(opts).summary.possible,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM station_schedules').get().n,3);
  }finally{db.close();local.close();}
});
test('daily extremes rank distinct services over all history, with searchable pages beyond the newest 200',async()=>{
  const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
  const events=Array.from({length:260},(_,i)=>({routeId:1,tripId:`service-${i}`,serviceDate:'2026-10-07',startTime:'12:00:00',stopId:'2716-abcdef12',sequence:1,kind:'arrival',eventTime:now+i*60,scheduledTime:now+i*60,delaySec:i===0?900:i===1?-300:0,reportedAt:now+i*60}));
  events.push({...events[0],sequence:2,delaySec:1200,eventTime:now+1});
  try{const batch={events,cancellations:[]};local.ingest(batch);await cloud.ingest(batch);
    const a=await cloud.report(filters);assert.equal(a.events.length,200);assert.equal(a.extremes[0].late.length,1);assert.equal(a.extremes[0].late[0].delay_sec,1200);assert.equal(a.extremes[0].early[0].trip_id,'service-1');
    const searched=await cloud.report({...filters,search:'service-0'});assert.equal(searched.totalEvents,2);
    const named=await cloud.report({...filters,search:'Papakura',page:2});assert.equal(named.totalEvents,261);assert.equal(named.events.length,61);
    assert.deepEqual(named.summary,local.report({...filters,search:'Papakura',page:2}).summary);
    assert.equal((await cloud.exportRows({...filters,search:'service-0'})).length,2);
  }finally{db.close();local.close();}
});
test('SQL clock search matches Auckland civil time across daylight-saving changes and overnight windows',async()=>{
  const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
  const cases=[{date:'2026-09-27',from:'01:30',to:'03:30',times:['2026-09-26T13:45:00Z','2026-09-26T14:15:00Z','2026-09-26T14:45:00Z']},
    {date:'2026-04-05',from:'02:00',to:'02:59',times:['2026-04-04T13:30:00Z','2026-04-04T14:30:00Z','2026-04-04T15:30:00Z']},
    {date:'2026-10-07',from:'22:00',to:'02:00',times:['2026-10-07T10:30:00Z','2026-10-07T12:30:00Z','2026-10-07T00:30:00Z']}];
  try{for(const c of cases){const batch={events:c.times.map((stamp,i)=>({routeId:1,tripId:`${c.date}-${i}`,serviceDate:c.date,startTime:'',stopId:'2716-abcdef12',sequence:1,kind:'arrival',eventTime:Date.parse(stamp)/1000,scheduledTime:Date.parse(stamp)/1000,delaySec:0,reportedAt:Date.parse(stamp)/1000})),cancellations:[]};local.ingest(batch);await cloud.ingest(batch);
      const opts={...filters,from:c.date,to:c.date,timeFrom:c.from,timeTo:c.to};assert.equal((await cloud.report(opts)).totalEvents,2);assert.equal(local.report(opts).totalEvents,2);
    }assert.throws(()=>options(new URL('https://example.test?timeFrom=25:00')),/HH:MM/);
  }finally{db.close();local.close();}
});

test('station departure bounds prove possible transfers without inventing arrivals or misses',()=>{
  const X=require('../performance/transfers.cjs'),routes=[{id:1,code:'376',mode:'bus'},{id:2,code:'S-C',mode:'train'}],t=now-1000;
  const row=(route_id,trip_id,sequence,scheduled_time,destination)=>({route_id,trip_id,sequence,scheduled_time,destination,service_date:'2026-10-07',stop_id:route_id===1?'2716':'9230',pickup_type:0});
  const schedules=[row(1,'b',3,t-1800,'Drury'),row(1,'b',31,t,'Papakura'),row(2,'tr',4,t+120,'City Centre')];
  const event=(s,kind,time)=>({...s,kind,event_time:time,scheduled_time:s.scheduled_time,delay_sec:time-s.scheduled_time,reported_at:now});
  const events=[event(schedules[1],'departure',t-60),event(schedules[2],'departure',t+120)];
  let p=X.analyze(schedules,events,[],routes,{...filters,now}).pairs[0];
  assert.equal(p.status,'possible');assert.equal(p.busTime,null);assert.equal(p.busDeparture,t-60);assert.equal(p.gap,180);assert.equal(p.gapIsMinimum,true);assert.equal(p.evidence,'conservative');
  events[0].event_time=t+60;p=X.analyze(schedules,events,[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'unknown');assert.equal(p.gap,null);
  events.push(event(schedules[1],'arrival',t+30));p=X.analyze(schedules,events,[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'missed');assert.equal(p.evidence,'exact');assert.equal(p.gap,90);
});
test('Pukekohe train to 376 uses train arrival and first-visit bus departure, retaining the intended bus',()=>{
  const X=require('../performance/transfers.cjs'),routes=[{id:1,code:'376',mode:'bus'},{id:2,code:'S-C',mode:'train'}],t=now-1500;
  const row=(route_id,trip_id,sequence,scheduled_time,destination)=>({route_id,trip_id,sequence,scheduled_time,destination,service_date:'2026-10-07',stop_id:route_id===1?'2716':'9228',pickup_type:0});
  const schedules=[row(1,'b',3,t+120,'Drury'),row(1,'b',31,t+1920,'Papakura'),row(1,'later',3,t+720,'Drury'),row(1,'later',31,t+2520,'Papakura'),row(2,'south',20,t,'Pukekohe'),row(2,'city',4,t,'City Centre')];
  const event=(s,kind,time)=>({...s,kind,event_time:time,scheduled_time:s.scheduled_time,delay_sec:time-s.scheduled_time,reported_at:now});
  const events=[event(schedules[4],'arrival',t+60),event(schedules[4],'departure',t+90),event(schedules[0],'departure',t+200)];
  const opts={...filters,now,walk:120,connection:'train-bus'};
  let report=X.analyze(schedules,events,[],routes,opts);assert.equal(report.pairs.length,1);assert.equal(report.pairs[0].busTrip,'b');assert.equal(report.pairs[0].busVisit,1);assert.equal(report.pairs[0].busSequence,3);assert.equal(report.summary.possible,1);assert.equal(report.pairs[0].gap,140);
  events[2].event_time=t+170;report=X.analyze(schedules,events,[],routes,opts);assert.equal(report.summary.missed,1);assert.equal(report.pairs[0].busTrip,'b');
  events[2].event_time=t+250;report=X.analyze(schedules,events.slice(1),[],routes,opts);assert.equal(report.summary.unknown,1);assert.equal(report.pairs[0].trainArrival,null);
  events[2].event_time=t+800;report=X.analyze(schedules,events,[],routes,opts);assert.equal(report.summary.missed,1);assert.match(report.pairs[0].reason,/outside/);
  report=X.analyze(schedules,events.slice(1),[],routes,opts);assert.equal(report.summary.missed,1);assert.equal(report.summary.conservative,1);
  report=X.analyze(schedules,events.filter(e=>e.route_id!==1),[],routes,opts);assert.equal(report.summary.unknown,1);assert.equal(report.summary.measured,0);
  report=X.analyze(schedules,events,[{route_id:1,trip_id:'b',service_date:'2026-10-07'}],routes,opts);assert.equal(report.summary.cancelled,1);
  assert.throws(()=>X.transferOptions(new URL('https://example.test?connection=invalid')),/connection/);
});
test('scheduled sampler spaces three polls and stops on failures, backoff or a slow run',async()=>{
  const {collectScheduled}=await import('../performance/cloud/worker.mjs');let time=100000,calls=[];
  const clock=()=>time,sleep=async ms=>{time+=ms},cleanup=async()=>{};
  await collectScheduled({}, {clock,sleep,cleanup,offsets:[0,20000,40000],sample:async(env,stamp)=>{calls.push(stamp);time+=1000;return {error:null}}});assert.deepEqual(calls,[100000,120000,140000]);
  calls=[];await collectScheduled({}, {clock,sleep,cleanup,sample:async()=>{calls.push(time);return {error:'429',retryAt:time+60000}}});assert.equal(calls.length,1);
  calls=[];await collectScheduled({}, {clock,sleep,cleanup,sample:async()=>{calls.push(time);time+=56000;return {error:null}}});assert.equal(calls.length,1);
});

test('three-calendar-month retention uses Auckland dates and clamps month ends',()=>{
 const {policy}=require('../performance/retention.cjs');
 assert.equal(policy(Date.parse('2026-10-06T11:01:00Z')).cutoff,'2026-07-07');
 assert.equal(policy(Date.parse('2026-05-31T00:00:00Z')).cutoff,'2026-02-28');
 assert.equal(policy(Date.parse('2024-05-31T00:00:00Z')).cutoff,'2024-02-29');
 assert.equal(policy(Date.parse('2026-01-31T00:00:00Z')).cutoff,'2025-10-31');
});
test('daily retention deletes expired history in local and D1 stores, preserves boundaries and configuration, and rolls back on failure',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
 const time=Date.parse('2026-10-06T11:01:00Z'),dates=['2026-07-06','2026-07-07','2026-07-08'];
 try{
  for(const store of [local,cloud]){
   const batch={events:dates.map(serviceDate=>({routeId:1,tripId:'b',serviceDate,startTime:'',stopId:'2716',sequence:3,kind:'arrival',eventTime:now,scheduledTime:now,delaySec:0,reportedAt:now})),cancellations:dates.map(serviceDate=>({routeId:1,tripId:'cancel',serviceDate,startTime:'',reportedAt:now}))};
   await store.ingest(batch);await store.saveSchedules(dates.map(service_date=>({route_id:1,trip_id:'b',service_date,stop_id:'2716',stop_code:'2716',sequence:3,scheduled_time:now,destination:'Drury',pickup_type:0,seen_at:now})));await store.toggle(1,false);
  }
  for(const [store,database] of [[local,local.db],[cloud,db]]){
   database.exec("CREATE TRIGGER fail_retention BEFORE INSERT ON state WHEN NEW.key='retention' BEGIN SELECT RAISE(ABORT,'test failure'); END");
   await assert.rejects(async()=>await store.purgeHistory(time),/test failure/);
   for(const table of ['events','cancellations','station_schedules'])assert.equal(database.prepare('SELECT COUNT(*) n FROM '+table).get().n,3);
   assert.equal(await store.getState('retention'),null);database.exec('DROP TRIGGER fail_retention');
   const first=await store.purgeHistory(time);assert.equal(first.cutoff,'2026-07-07');
   for(const table of ['events','cancellations','station_schedules'])assert.deepEqual(database.prepare('SELECT service_date FROM '+table+' ORDER BY service_date').all().map(r=>r.service_date),dates.slice(1));
   assert.equal((await store.routes()).find(r=>r.id===1).active,0);assert.equal((await store.routes()).length,2);assert.equal(await store.getState('initialized'),true);
   assert.deepEqual(await store.purgeHistory(time+3600000),first);
   await store.purgeHistory(time+86400000);for(const table of ['events','cancellations','station_schedules'])assert.equal(database.prepare('SELECT COUNT(*) n FROM '+table).get().n,1);
  }
 }finally{db.close();local.close();}
});
test('retention is attempted even when transport collection fails',async()=>{
 const {collectScheduled}=await import('../performance/cloud/worker.mjs');let cleaned=0,sampled=0;
 await collectScheduled({}, {clock:()=>1000,cleanup:async()=>{cleaned++;},sample:async()=>{sampled++;return {error:'Feed down'};}});
 assert.equal(cleaned,1);assert.equal(sampled,1);
});

function gpsFixtures(){
 const P=require('../performance/positions.cjs'),t=now-500;
 const schedules=[{route_id:1,trip_id:'b',service_date:'2026-10-07',stop_id:'2716',sequence:3,scheduled_time:t-1800,destination:'Drury',pickup_type:0},{route_id:1,trip_id:'b',service_date:'2026-10-07',stop_id:'2716',sequence:31,scheduled_time:t,destination:'Papakura',pickup_type:0},{route_id:2,trip_id:'tr',service_date:'2026-10-07',stop_id:'9230',sequence:4,scheduled_time:t+120,destination:'City Centre',pickup_type:0}];
 const point=(offset,metres,extra={})=>({route_id:1,trip_id:'b',service_date:'2026-10-07',start_time:'12:00:00',vehicle_id:'v',vehicle_label:'Bus v',position_time:t+offset,latitude:P.station.latitude+metres/111195,longitude:P.station.longitude,distance:Math.abs(metres),progress_sequence:31,...extra});
 return {P,t,schedules,point,positions:[point(-20,110),point(0,3),point(20,4),point(40,120)],routes:[{id:1,code:'376',mode:'bus'},{id:2,code:'S-C',mode:'train'}]};
}
test('untracked trains get timetable conclusions only with the correct reported bus station departure, with walking time and observed trains taking priority',()=>{
 const {t,schedules,routes}=gpsFixtures(),X=require('../performance/transfers.cjs');
 const event=(kind,time,station=schedules[1])=>({...station,kind,event_time:time,delay_sec:0,reported_at:now,start_time:''});
 let report=X.analyze(schedules,[event('departure',t)],[],routes,{...filters,now});let p=report.pairs[0];assert.equal(p.status,'estimated-possible');assert.equal(p.evidence,'timetable');assert.equal(p.timetableGap,120);assert.equal(report.summary.measured,0);assert.equal(report.summary.timetablePossible,1);assert.equal(p.trainDeparture,null);
 p=X.analyze(schedules,[event('arrival',t-10)],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'unknown');
 p=X.analyze(schedules,[event('departure',t+121)],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'estimated-missed');assert.match(p.reason,/delayed train/);
 p=X.analyze(schedules,[event('arrival',t-10),event('departure',t+121)],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'estimated-possible');assert.equal(p.timetableUsesDeparture,false);
 p=X.analyze(schedules,[event('departure',t+1)],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'estimated-missed');assert.match(p.reason,/earlier bus arrival/);
 p=X.analyze(schedules,[event('departure',t),event('departure',t+60,schedules[2])],[],routes,{...filters,now}).pairs[0];assert.notEqual(p.evidence,'timetable');assert.equal(p.status,'unknown');
 p=X.analyze(schedules,[event('departure',t),event('arrival',t+30,schedules[2])],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'unknown');
 p=X.analyze(schedules,[event('departure',t)], [{route_id:2,trip_id:'tr',service_date:'2026-10-07'}],routes,{...filters,now}).pairs[0];assert.equal(p.status,'cancelled');
 p=X.analyze(schedules,[event('departure',t,schedules[0])],[],routes,{...filters,now}).pairs[0];assert.equal(p.status,'unknown');
});
test('GPS requires fresh vehicle timestamps and correct routes, not a fresh feed wrapping stale positions',()=>{
 const {P}=gpsFixtures(),store=new Store(':memory:');
 const vehicle={trip:{trip_id:'b',route_id:'376-202',start_date:'20261007',start_time:'12:00:00'},timestamp:now-10,position:{latitude:P.station.latitude,longitude:P.station.longitude},vehicle:{id:'v'}};
 const payload={header:{timestamp:now},entity:[{vehicle},{vehicle:{...vehicle,timestamp:now-121}},{vehicle:{...vehicle,timestamp:now+1}},{vehicle:{...vehicle,trip:{...vehicle.trip,route_id:'1376-202'}}}]};
 assert.equal(P.extract(payload,store.routes(),metadata,now).length,1);assert.throws(()=>P.extract({...payload,header:{timestamp:now-121}},store.routes(),metadata,now),/stale/);store.close();
});
test('GPS dwell matches the correct station visit; passing, sparse, ambiguous and conflicting progress samples stay unclassified',()=>{
 const {P,t,schedules,point,positions}=gpsFixtures();const key=JSON.stringify([1,'b','2026-10-07','2716',31]);
 const visit=P.visits(schedules,positions).get(key);assert.equal(visit.arrivalFrom,t-20);assert.equal(visit.arrivalTo,t);assert.equal(visit.departureFrom,t+20);assert.equal(visit.departureTo,t+40);assert.equal(visit.samples,2);
 assert.equal(P.visits(schedules,[point(0,-30),point(20,30)]).size,0);assert.equal(P.visits(schedules,[point(0,3),point(200,4)]).size,0);
 assert.equal(P.visits(schedules,positions.map(p=>({...p,progress_sequence:10}))).size,0);
 assert.equal(P.visits(schedules,[...positions,point(10,3,{start_time:'12:30:00'})]).size,0);
 assert.equal(P.visits(schedules,[...positions,point(10,3,{vehicle_id:'other'})]).size,0);
 assert.equal(P.visits(schedules.filter(s=>s.sequence!==3),positions).size,0);
 const first=positions.map(p=>({...p,position_time:p.position_time-1800,progress_sequence:3}));assert.equal(P.visits(schedules,first).has(JSON.stringify([1,'b','2026-10-07','2716',3])),true);
});
test('GPS transfer estimates use intervals, stay separate from measured rates and yield to reported times',()=>{
 const {t,schedules,positions,routes}=gpsFixtures(),X=require('../performance/transfers.cjs');
 const departure={...schedules[2],kind:'departure',event_time:t+140,scheduled_time:t+120,delay_sec:20,reported_at:now,start_time:''};
 let report=X.analyze(schedules,[departure],[],routes,{...filters,now,positions});assert.equal(report.summary.estimatedPossible,1);assert.equal(report.summary.measured,0);assert.equal(report.summary.successPercent,null);assert.equal(report.pairs[0].busTime,null);assert.equal(report.pairs[0].gpsGapFrom,140);
 departure.event_time=t+50;report=X.analyze(schedules,[departure],[],routes,{...filters,now,positions});assert.equal(report.summary.estimatedMissed,1);
 departure.event_time=t+110;report=X.analyze(schedules,[departure],[],routes,{...filters,now,positions});assert.equal(report.summary.unknown,1);
 const arrival={...schedules[1],kind:'arrival',event_time:t-20,scheduled_time:t,delay_sec:-20,reported_at:now,start_time:'12:00:00'};report=X.analyze(schedules,[departure,arrival],[],routes,{...filters,now,positions});assert.equal(report.summary.possible,1);assert.equal(report.summary.estimatedPossible,0);assert.equal(report.pairs[0].evidence,'exact');
 const south={...schedules[2],stop_id:'9228',trip_id:'south',destination:'Pukekohe',scheduled_time:t-1800};
 const trainArrival={...south,kind:'arrival',event_time:t-1960,scheduled_time:t-1800,delay_sec:-160,reported_at:now,start_time:''};
 const firstPositions=positions.map(p=>({...p,position_time:p.position_time-1800,progress_sequence:3}));report=X.analyze([...schedules,south],[trainArrival],[],routes,{...filters,now,positions:firstPositions,connection:'train-bus'});assert.equal(report.summary.estimatedPossible,1);assert.equal(report.pairs[0].busSequence,3);
});
test('GPS snapshots deduplicate in both stores, join identical transfers and obey three-month retention',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:'),{t,schedules,positions}=gpsFixtures();
 try{
  for(const store of [local,cloud]){await store.saveSchedules(schedules.map(s=>({...s,stop_code:String(s.stop_id),seen_at:now})));await store.savePositions(positions);await store.savePositions(positions);}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM station_positions').get().n,4);assert.equal(local.db.prepare('SELECT COUNT(*) n FROM station_positions').get().n,4);
  assert.deepEqual((await cloud.transfers(filters)).pairs,local.transfers(filters).pairs);
  for(const store of [local,cloud])await store.savePositions(positions.map(p=>({...p,service_date:'2026-06-01'})));
  for(const [store,database] of [[local,local.db],[cloud,db]]){await store.purgeHistory(now*1000);assert.equal(database.prepare('SELECT COUNT(*) n FROM station_positions').get().n,4);}
 }finally{db.close();local.close();}
});

test('occupancy keeps zero and supplied percentages, preserves categories, and rejects stale or unrelated vehicles',()=>{
 const O=require('../performance/occupancy.cjs'),store=new Store(':memory:');
 const vehicle={trip:{trip_id:'b',route_id:'376-202',start_date:'20261007'},timestamp:now-10,vehicle:{id:'v'},occupancy_status:0,occupancy_percentage:0};
 const payload={header:{timestamp:now},entity:[{vehicle},{vehicle:{...vehicle,trip:{...vehicle.trip,trip_id:'no-data'},occupancy_status:undefined,occupancy_percentage:undefined}},{vehicle:{...vehicle,trip:{...vehicle.trip,trip_id:'crowded'},occupancy_status:'FULL',occupancy_percentage:110}},{vehicle:{...vehicle,timestamp:now-121}},{vehicle:{...vehicle,trip:{...vehicle.trip,route_id:'1376-202'}}}]};
 const rows=O.extract(payload,store.routes(),metadata,now);assert.equal(rows.length,3);assert.equal(rows[0].occupancy_status,0);assert.equal(rows[0].occupancy_percentage,0);assert.equal(rows[1].occupancy_status,null);assert.equal(rows[2].occupancy_percentage,110);
 store.toggle(1,false);assert.equal(O.extract(payload,store.routes(),metadata,now).length,0);store.close();
});
test('occupancy reports category distributions and trip-balanced real percentages, deduplicates five-minute samples and purges old data',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),cloud=new CloudStore(wrapper),local=new Store(':memory:');
 const make=(trip_id,offset,status,percentage)=>({route_id:1,trip_id,service_date:'2026-10-07',start_time:'',vehicle_id:'v',sample_time:now+offset,sample_bucket:Math.floor((now+offset)/300),occupancy_status:status,occupancy_percentage:percentage});
 const rows=[make('a',0,1,0),make('a',300,1,100),make('b',0,5,100),make('c',0,null,null)];
 try{
  for(const store of [local,cloud]){await store.saveOccupancy(rows);await store.saveOccupancy([rows[0],{...rows[0],sample_time:rows[0].sample_time+10,occupancy_status:5}]);}
  let report=await cloud.occupancy(filters);assert.deepEqual(report,local.occupancy(filters));const r=report.routes[0];assert.equal(r.samples,4);assert.equal(r.trips,3);assert.equal(r.typical,'Many seats available');assert.equal(r.averagePercentage,75);assert.equal(r.unknown,1);assert.equal(r.standingOrFullPercent,100/3);
  report=await cloud.occupancy({...filters,search:'a'});assert.deepEqual(report,local.occupancy({...filters,search:'a'}));
  report=await cloud.occupancy({...filters,search:'Papakura'});assert.equal(report.routes[0].samples,0);
  for(const store of [local,cloud]){await store.saveOccupancy([make('category-only',600,2,null)]);const only=await store.occupancy({...filters,search:'category-only'});assert.equal(only.routes[0].averagePercentage,null);assert.equal(only.routes[0].typical,'Few seats available');await store.saveOccupancy([{...rows[0],service_date:'2026-06-01'}]);await store.purgeHistory(now*1000);}
  assert.equal(db.prepare('SELECT COUNT(*) n FROM occupancy_samples').get().n,5);assert.equal(local.db.prepare('SELECT COUNT(*) n FROM occupancy_samples').get().n,5);
 }finally{db.close();local.close();}
});


test('trip endpoints use origin departure and destination arrival, preserve instances, loops and missing reports',()=>{
 const Trips=require('../performance/trips.cjs'),archive=Trips.timetable(tripFixture(),'loop','2026-10-07',1),stops=JSON.parse(archive.stops_json),selection={routeId:1,date:'2026-10-07',tripId:'loop',startTime:'10:00:00'};
 const event=(sequence,kind,time,delay,start='10:00:00')=>({route_id:1,trip_id:'loop',service_date:selection.date,start_time:start,stop_id:'2716-12345678',sequence,kind,event_time:time,delay_sec:delay,reported_at:now});
 const events=[event(1,'arrival',stops[0].scheduledArrival-300,-300),event(1,'departure',stops[0].scheduledDeparture-30,-30),event(3,'arrival',stops[2].scheduledArrival+120,120),event(3,'departure',stops[2].scheduledDeparture+600,600),event(1,'departure',stops[0].scheduledDeparture+900,900,'10:30:00')];
 const endpoints=Trips.detail(archive,events,false,selection,now).endpoints;
 assert.equal(endpoints.start.delay,-30);assert.equal(endpoints.start.kind,'departure');assert.equal(endpoints.end.delay,120);assert.equal(endpoints.end.kind,'arrival');assert.equal(endpoints.start.sequence,1);assert.equal(endpoints.end.sequence,3);
 const missing=Trips.detail(archive,events.filter(e=>e.kind==='departure'&&e.sequence===3),false,selection,stops[2].scheduledArrival+1000).endpoints;
 assert.equal(missing.start.status,'Not captured');assert.equal(missing.end.status,'Not captured');assert.equal(missing.start.delay,null);assert.equal(missing.end.delay,null);
 assert.equal(Trips.detail(archive,[],false,selection,stops[0].scheduledArrival-60).endpoints.start.status,'Pending');
 assert.equal(Trips.detail(archive,[],true,selection).endpoints.end.status,'Cancelled');
 assert.equal(Trips.detail(null,events,false,selection).endpoints.start.status,'Timetable unavailable');
});

test('cloud state checkpoints update without replacing indexed keys and skip identical values',async()=>{
 const {CloudStore}=await import('../performance/cloud/store.mjs'),{db,wrapper}=sqliteD1(),store=new CloudStore(wrapper);
 try{
  await store.setState('positions',{sample:1});const initial=db.prepare("SELECT rowid FROM state WHERE key='positions'").get().rowid;
  db.exec("CREATE TABLE state_deletes(key TEXT); CREATE TRIGGER record_state_delete AFTER DELETE ON state BEGIN INSERT INTO state_deletes VALUES(old.key); END; PRAGMA recursive_triggers=ON;");
  await store.setState('positions',{sample:2});assert.equal(db.prepare("SELECT rowid FROM state WHERE key='positions'").get().rowid,initial);assert.equal(db.prepare('SELECT COUNT(*) n FROM state_deletes').get().n,0);
  const changes=db.prepare('SELECT total_changes() n').get().n;await store.setState('positions',{sample:2});assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 }finally{db.close();}
});
