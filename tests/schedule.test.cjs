const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const S=require('../schedule-data.js');
const now=Date.parse('2026-10-02T22:00:00Z')/1000; // Auckland 11:00, 3 October
const fixture=(extra={})=>({type:'string',id:'row',attributes:{arrival_time:'11:10:00',departure_time:'11:11:00',
  direction_id:1,drop_off_type:0,pickup_type:0,route_id:'E-W-201',service_date:'2026-10-03',
  stop_headsign:'MANUKAU',stop_id:'9297-abcdef12',stop_sequence:3,trip_headsign:'East West',trip_id:'trip',...extra}});
const scheduled=(extra={})=>({tripId:'trip',serviceDate:'2026-10-03',stopId:'9297-abcdef12',sequence:3,scheduledTime:now+600,...extra});

test('the supplied stoptrips schema yields a dated platform departure and destination',()=>{
  const candidates=S.candidates({data:[fixture()]},'9297-12345678','2026-10-02');
  const row=S.departure(candidates[0]);
  assert.equal(row.serviceDate,'2026-10-03');
  assert.equal(row.scheduledTime,now+660);
  assert.equal(row.destination,'MANUKAU');
  assert.equal(row.routeId,'E-W-201');
});
test('clock times, 24+ hours and ISO timestamps parse in Auckland; date-only examples do not',()=>{
  assert.equal(new Date(S.timeEpoch('25:24:00','2026-10-03')*1000).toISOString(),'2026-10-03T12:24:00.000Z');
  assert.equal(S.timeEpoch('2026-10-03T11:10:00+13:00'),now+600);
  assert.equal(S.timeEpoch('2026-10-03T11:10:00'),now+600);
  for(const value of ['2026-06-23','11:70:00','garbage','72:00:00']) assert.equal(S.timeEpoch(value,'2026-10-03'),null);
  assert.equal(S.timeEpoch('11:00:00','2026-02-30'),null);
});
test('GTFS noon-minus-12-hours semantics survive NZ daylight-saving transitions',()=>{
  assert.equal(new Date(S.timeEpoch('02:30:00','2026-09-27')*1000).toISOString(),'2026-09-26T13:30:00.000Z');
  assert.equal(new Date(S.timeEpoch('01:30:00','2026-04-05')*1000).toISOString(),'2026-04-04T13:30:00.000Z');
  assert.equal(new Date(S.timeEpoch('02:30:00','2026-04-05')*1000).toISOString(),'2026-04-04T14:30:00.000Z');
  assert.equal(S.timeEpoch('2026-09-27T02:30:00'),null);
});
test('query windows cover previous service dates, midnight and delayed trains',()=>{
  const night=S.windows(Date.parse('2026-10-03T12:24:00Z')/1000);
  assert.ok(night.some(w=>w.date==='2026-10-03' && w.startHour===24));
  assert.ok(night.some(w=>w.date==='2026-10-04'));
  const midnight=S.windows(Date.parse('2026-10-03T10:30:00Z')/1000);
  assert.ok(midnight.some(w=>w.date==='2026-10-04' && w.startHour===0));
  assert.equal(S.windows(now)[0].startHour,10);
  const fall=S.windows(Date.parse('2026-04-04T15:05:00Z')/1000);
  assert.equal(fall[0].startHour,2); // includes the preceding GTFS hour after the repeated local hour
});
test('wrong platform and drop-off-only records cannot create departures',()=>{
  assert.equal(S.candidates({data:[fixture({stop_id:'9001-abcdef12'})]},'9297-abcdef12','2026-10-03').length,0);
  assert.equal(S.departure(S.candidates({data:[fixture({pickup_type:1})]},'9297-abcdef12','2026-10-03')[0]),null);
});
test('timetable rows remain explicitly scheduled without a current live forecast',()=>{
  const rows=S.mergeDepartures([scheduled()],new Map(),{now});
  assert.equal(rows[0].status,'scheduled');
  assert.equal(rows[0].etaSec,now+600);
});
test('matching live times and delay-only updates replace schedules; other stops cannot',()=>{
  const update={trip:{start_date:'20261003'},timestamp:now,stop_time_update:{stop_id:'9297-12345678',stop_sequence:3,departure:{time:now+900,delay:300}}};
  let row=S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0];
  assert.equal(row.status,'live');assert.equal(row.etaSec,now+900);
  delete update.stop_time_update.departure.time;
  row=S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0];
  assert.equal(row.status,'estimated');assert.equal(row.etaSec,now+900);
  update.stop_time_update.stop_id='9001-abcdef12';
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0].status,'scheduled');
});
test('cancellations are labelled, passed stops removed, and stale/offline data does not change schedules',()=>{
  const update={trip:{schedule_relationship:'3',start_date:'20261003'},timestamp:now};
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0].status,'canceled');
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now,liveFresh:false})[0].status,'canceled');
  update.trip.schedule_relationship=0;update.stop_time_update={stop_id:'9297-abcdef12',departure:{time:now+900}};
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now,sequenceForTrip:()=>4}).length,0);
  update.timestamp=now-121;
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0].status,'scheduled');
  update.timestamp=now;update.trip.start_date='20261002';
  assert.equal(S.mergeDepartures([scheduled()],new Map([['trip',update]]),{now})[0].status,'scheduled');
});

function handler(fetch,extra={}){
  const context=vm.createContext({ScheduleData:S,fetch,URL,AbortController,setTimeout,clearTimeout,
    process:{env:{AT_API_KEY:'test'}},Date:{now:()=>now*1000},...extra});
  const code=fs.readFileSync(path.join(__dirname,'../api/departures.js'),'utf8')
    .replace("import ScheduleData from '../schedule-data.js';",'').replace('export default async function handler','async function handler');
  vm.runInContext(code,context);return context;
}
async function call(context,ids='9297-abcdef12'){
  const response={headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.data=data;return this;}};
  await context.handler({method:'GET',query:{ids}},response);return response;
}
const reply=(data,status=200)=>({ok:status===200,status,headers:{get:()=>null},text:async()=>JSON.stringify(data)});
test('departures proxy uses direct stoptrips times and caches complete upstream queries',async()=>{
  let calls=0;
  const context=handler(async url=>{calls++;assert.match(url,/stoptrips\?/);const parsed=new URL(url);
    assert.equal(parsed.searchParams.get('filter[date]'),'2026-10-03');assert.equal(parsed.searchParams.get('filter[start_hour]'),'10');
    return reply({data:[fixture()]});});
  let response=await call(context);assert.equal(response.code,200);assert.equal(response.data.data.length,1);
  assert.equal(response.data.complete,true);assert.match(response.headers['Cache-Control'],/s-maxage=15/);
  response=await call(context);assert.equal(calls,1);assert.equal(response.data.data[0].scheduledTime,now+660);
});
test('proxy fallback uses trip stoptimes only when platform records have no clock time',async()=>{
  const urls=[];
  const context=handler(async url=>{urls.push(url);return reply({data:[fixture(url.includes('stoptrips')?{arrival_time:'2026-06-23',departure_time:'2026-06-23'}:{})]});});
  const response=await call(context);assert.equal(response.data.data.length,1);assert.equal(urls.length,2);
  assert.match(urls[1],/trips\/trip\/stoptimes$/);
});
test('date-only responses are reported as incomplete, never turned into midnight trains',async()=>{
  const context=handler(async()=>reply({data:[fixture({arrival_time:'2026-06-23',departure_time:'2026-06-23'})]}));
  const response=await call(context);assert.equal(response.data.data.length,0);assert.equal(response.data.complete,false);
  assert.equal(response.data.invalidTimeCount,1);assert.equal(response.headers['Cache-Control'],'no-store');
});
test('platform failure preserves valid departures and never caches a partial board',async()=>{
  const context=handler(async url=>url.includes('9001-abcdef12')?reply({},503):reply({data:[fixture()]}));
  const response=await call(context,'9297-abcdef12,9001-abcdef12');
  assert.equal(response.code,200);assert.equal(response.data.data.length,1);assert.equal(response.data.complete,false);
  assert.equal(response.headers['Cache-Control'],'no-store');
});
test('body stalls and rate limits terminate requests and preserve retry headers',async()=>{
  const context=handler(async(_url,{signal})=>({ok:true,status:200,text:()=>new Promise((_,reject)=>
    signal.addEventListener('abort',()=>reject(Error('body aborted'))))}),{setTimeout:fn=>setTimeout(fn,5)});
  const response=await call(context);assert.equal(response.code,502);assert.equal(response.headers['Cache-Control'],'no-store');
  assert.equal(context.__AT_DEPARTURES_PENDING__.size,0);
  const limited=handler(async()=>({ok:false,status:429,headers:{get:()=> '42'},text:async()=>''}));
  const failure=await call(limited);assert.equal(failure.code,429);assert.equal(failure.headers['Retry-After'],'42');
});
test('pagination cannot send the AT credential to another host or endpoint',async()=>{
  let calls=0;
  const context=handler(async()=>{calls++;return reply({data:[fixture()],links:{next:'https://example.com/leak'}});});
  const response=await call(context);assert.equal(calls,1);assert.equal(response.code,502);
  assert.equal(context.__AT_DEPARTURES_CACHE__.size,0);
});
test('missing configuration and malformed requests fail without any upstream call',async()=>{
  const context=handler(async()=>{throw Error('Unexpected request');},{process:{env:{}}});
  assert.equal((await call(context)).code,503);
  assert.equal((await call(context,'../secret')).code,400);
});

test('concurrent timetable callers share an upstream request',async()=>{
  let calls=0,release;
  const wait=new Promise(resolve=>{release=resolve;});
  const context=handler(async()=>{calls++;await wait;return reply({data:[fixture()]});});
  const first=call(context),second=call(context);
  release();const results=await Promise.all([first,second]);
  assert.equal(calls,1);assert.ok(results.every(r=>r.data.complete));
  assert.equal(context.__AT_DEPARTURES_PENDING__.size,0);
});
