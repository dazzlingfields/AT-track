const {test}=require('node:test');
const assert=require('node:assert/strict');
const T=require('../transit-data.js');
const now=100000;
const stu=(stop,time,seq=1)=>({stop_id:stop,stop_sequence:seq,arrival:{time}});
const tu=(stops,extra={})=>({trip:{trip_id:'trip',route_id:'rail'},timestamp:now,stop_time_update:stops,...extra});
const options={now,resolveStop:id=>id==='9297-newhash'?'station':id,serviceForTrip:()=>({badge:'E-W',color:'#f5a623',dest:'Manukau'})};
const board=(updates,opts={})=>T.buildArrivals(new Map(updates),{...options,...opts});

test('legacy single-object and standard array stop updates are both usable',()=>{
  assert.equal(T.stopUpdates(tu(stu('a',now+60))).length,1);
  assert.equal(T.stopUpdates(tu([stu('a',now+60),stu('b',now+120)])).length,2);
  assert.equal(T.entities({response:{entity:{trip_update:tu([])}}}).length,1);
  assert.deepEqual(T.entities({}),[]);
});
test('station arrivals include trips without a visible vehicle and every remaining stop',()=>{
  const stops=Array.from({length:20},(_,i)=>stu(`stop${i}`,now+60+i,i+1));
  const r=board([['no-vehicle',tu(stops)]]);
  assert.equal(r.byStop.size,20);
  assert.equal(r.byStop.get('stop19')[0].tripId,'no-vehicle');
});
test('canceled trips, skipped/no-data stops, and passed sequences are excluded',()=>{
  for(const status of [3,7,'CANCELED','CANCELLED','DELETED']){
    assert.equal(board([['trip',tu(stu('a',now+60),{trip:{schedule_relationship:status}})]]).byStop.size,0);
  }
  const stops=[stu('passed',now+60,1),...['SKIPPED','NO_DATA',3].map((status,i)=>({...stu('skip'+i,now+60,2),schedule_relationship:status})),stu('future',now+60,3)];
  assert.deepEqual([...board([['trip',tu(stops)]],{sequenceForTrip:()=>2}).byStop.keys()],['future']);
});
test('time bounds, missing times and stale trip timestamps are handled without inventing ETAs',()=>{
  const r=board([['trip',tu([stu('past',now-90),stu('late',now+3601),stu('missing',undefined),stu('next',now+60)])],
    ['old',tu(stu('old',now+60),{timestamp:now-121})]]);
  assert.deepEqual([...r.byStop.keys()],['next']);
  assert.equal(r.stats.missingTimes,1);
  assert.equal(r.stats.staleTrips,1);
});
test('departure ahead of a past arrival keeps a dwelling train on the board',()=>{
  const stop={...stu('station',now-40),departure:{time:now+60}};
  assert.equal(board([['trip',tu(stop)]]).byStop.get('station')[0].etaSec,now+60);
});
test('duplicate stop updates do not duplicate services; loop revisits are retained',()=>{
  const r=board([['trip',tu([stu('station',now+60,1),stu('station',now+60,1),stu('station',now+600,9)])]]);
  assert.equal(r.byStop.get('station').length,2);
});
test('camel case, numeric strings and departure-only updates remain compatible',()=>{
  const r=board([['trip',{trip:{routeId:'rail'},stopTimeUpdate:{stopId:'station',stopSequence:'2',departure:{time:String(now+60),delay:'12'}}}]]);
  assert.equal(r.byStop.get('station')[0].delaySec,12);
});
test('AT stop suffix changes resolve safely; ambiguous numeric aliases do not',()=>{
  const exact=new Map([['9297-abcdef12','station'],['1234-aaaaaa','other'],['1234-bbbbbb','different'],['custom-stop','literal']]);
  const aliases=T.stopAliases(exact);
  assert.equal(T.resolveStop('9297-12345678',exact,aliases),'station');
  assert.equal(T.resolveStop('1234-12345678',exact,aliases),null);
  assert.equal(T.resolveStop('custom-changed',exact,aliases),null);
  assert.equal(T.resolveStop('1234-aaaaaa',exact,aliases),'other');
});
test('malformed coordinates are rejected while valid numeric strings are accepted',()=>{
  for(const p of [{latitude:null,longitude:174},{latitude:false,longitude:174},{latitude:' ',longitude:174},{latitude:NaN,longitude:174},{latitude:-91,longitude:174},{latitude:-36,longitude:181}]) assert.equal(T.validPosition(p),false);
  assert.equal(T.validPosition({latitude:'-36.85',longitude:'174.76'}),true);
});
test('GTFS bike allowance is displayed correctly, including string enums',()=>{
  assert.equal(T.bikesAllowed(1),'Yes');assert.equal(T.bikesAllowed('2'),'No');
  assert.equal(T.bikesAllowed(0),'');assert.equal(T.bikesAllowed(null),'');
});
