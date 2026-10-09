const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {DatabaseSync}=require('node:sqlite');
const S=require('../schedule-data.js'),I=require('../intercity-data.js'),T=require('../transit-data.js');
const source=fs.readFileSync(path.join(__dirname,'../script.js'),'utf8');
const helper=name=>source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
const at=(date,time='00:00')=>S.timeEpoch(time+':00',date);
test('current official Te Huia and Northern Explorer times at The Strand',()=>{
  const rows=I.services('The Strand Train Station',at('2026-10-09'),30).filter(r=>r.date==='2026-10-09');
  assert.deepEqual(rows.filter(r=>r.operator==='huia').map(r=>[r.time,r.kind]),[
    ['08:35','arrival'],['09:40','departure'],['12:00','arrival'],['15:40','departure'],['16:35','arrival'],['17:40','departure']]);
  assert.deepEqual(rows.filter(r=>r.operator==='explorer').map(r=>[r.time,r.kind]),[['19:00','arrival']]);
  assert.equal(I.services('The Strand',at('2026-10-10'),30).find(r=>r.operator==='explorer').time,'07:40');
});
test('Te Huia-only stations use static schedules, shared metro stations still query AT',async()=>{
  const context=vm.createContext({navigator:{onLine:true},isPageVisible:()=>true,departuresByStation:new Map(),departuresPending:new Map(),backoff:{departures:{until:0}},latestPlatformIds:new Map(),TransitData:T,departuresUrl:'/api/departures',resolveStopKey:()=>null,refreshOpenStopPopup:()=>{},_openStopMarker:null});
  vm.runInContext(source.match(/function isIntercityOnly[^\r\n]+/)[0]+'\n'+helper('loadStationDepartures'),context);
  for(const name of ['The Strand','Hamilton Frankton','Hamilton Rotokauri','Huntly']){
    assert.equal(context.isIntercityOnly({_stopType:1,_stopName:name}),true);
    await context.loadStationDepartures({_stopType:1,_stopName:name});
    assert.ok(I.services(name,at('2026-10-09')).length);
  }
  for(const name of ['Pukekohe','Puhinui'])assert.equal(context.isIntercityOnly({_stopType:1,_stopName:name}),false);
  const friday=I.services('Puhinui',at('2026-10-09'),40).filter(r=>r.date==='2026-10-09');
  assert.deepEqual(friday.map(r=>r.time),['07:59','10:08','11:29','15:59','16:08','18:08']);
});
test('static services obey running days, published closures, holidays and Auckland dates',()=>{
  for(const date of ['2026-10-26','2026-11-07','2026-11-08','2026-12-25','2027-01-10','2027-02-01'])
    assert.equal(I.services('The Strand',at(date),80).filter(r=>r.operator==='huia'&&r.date===date).length,0);
  assert.equal(I.services('The Strand',at('2027-01-11'),80).filter(r=>r.operator==='explorer'&&r.date==='2027-01-11').length,0);
  assert.equal(I.services('The Strand',at('2026-10-13'),80).filter(r=>r.operator==='explorer'&&r.date==='2026-10-13').length,0);
  assert.equal(I.services('The Strand',at('2026-10-09','23:59'))[0].date,'2026-10-10');
  assert.equal(I.services('Waitemata',at('2026-10-09')).length,0);
});
test('carriage counts require explicit complete GTFS details; labels and proximity prove nothing',()=>{
  for(const count of [3,6])assert.equal(T.carriageCount({multi_carriage_details:Array.from({length:count},(_,i)=>({carriage_sequence:i+1}))}),count);
  for(const v of [{vehicle:{label:'AMP 1059'}},{multi_carriage_details:[]},{multi_carriage_details:[{carriage_sequence:1},{carriage_sequence:3}]}])assert.equal(T.carriageCount(v),null);
});
test('station history weights recorded arrivals and deduplicates platform/stop-ID corrections',async()=>{
  const {stationAverages}=await import('../performance/cloud/station-averages.mjs');
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE routes(id INTEGER,code TEXT,mode TEXT); CREATE TABLE events(route_id INTEGER,trip_id TEXT,service_date TEXT,start_time TEXT,stop_id TEXT,sequence INTEGER,kind TEXT,event_time REAL,delay_sec REAL,reported_at REAL); INSERT INTO routes VALUES(1,\'S-C\',\'train\')');
  const now=at('2026-10-09','15:00');
  const add=(trip,stop,seq,delay,extra={})=>db.prepare('INSERT INTO events VALUES(1,?,?,?,?,?,?,?,?,?)').run(trip,extra.date||'2026-10-09','',stop,seq,extra.kind||'arrival',now-60,delay,extra.stamp||now);
  add('a','9228-oldhash',3,600,{stamp:now-1});add('a','9229-newhash',3,120);
  add('b','9229-newhash',3,0);add('c','9229-newhash',3,-60);add('d','9229-newhash',3,null);
  add('e','9229-newhash',3,900,{kind:'departure'});add('f','9229-newhash',3,900,{date:'2026-10-02'});
  const wrapper={prepare(sql){return {bind(...args){return {all:async()=>({results:db.prepare(sql).all(...args)})}}}}};
  try{const result=await stationAverages(wrapper,now*1000);assert.equal(result.from,'2026-10-03');assert.equal(result.stops.length,1);assert.equal(result.stops[0].measured,3);assert.equal(result.stops[0].observations,4);assert.equal(result.stops[0].averageDelay,20);assert.doesNotMatch(JSON.stringify(result),/trip_id|start_time/);}finally{db.close();}
});
test('public history caches a network snapshot and leaves private report authentication intact',async()=>{
  const {cachedStationAverages}=await import('../performance/cloud/station-averages.mjs');const worker=(await import('../performance/cloud/worker.mjs')).default;
  let reads=0;const env={DASHBOARD_PASSWORD:'test',DB:{prepare(){return {bind(){return {all:async()=>{reads++;return {results:[]}}}}}}}};
  const entries=new Map(),cache={match:async key=>entries.get(key.url)?.clone(),put:async(key,r)=>entries.set(key.url,r.clone())};
  const request=new Request('https://test/api/network/station-averages?stop=9228');
  await cachedStationAverages(request,env,null,cache);await cachedStationAverages(new Request('https://test/api/network/station-averages?stop=9001'),env,null,cache);assert.equal(reads,1);
  assert.equal((await worker.fetch(new Request('https://test/api/report'),env,{})).status,401);
  assert.equal((await worker.fetch(new Request(request.url,{method:'POST'}),env,{})).status,405);
});
