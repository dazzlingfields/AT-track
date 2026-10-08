const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const TransitData=require('../transit-data.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../script.js'),'utf8');
const helper=name=>source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];
function stops(){
  const context=vm.createContext({TransitData,stopById:new Map(),stopKeyById:new Map(),stopNameByKey:new Map()});
  vm.runInContext('const _normHdr=h=>h.toLowerCase().replace(/[^a-z0-9]/g,"");\n'+
    ['csvSplitLine','_pickCol','parseStopsCsv','dedupeStops'].map(helper).join('\n'),context);
  return {context,rows:context.parseStopsCsv(fs.readFileSync(require('node:path').join(__dirname,'../stops_bus.csv'),'utf8'))};
}
test('major bus hubs preserve all bays and IDs; ordinary road stops remain separate',()=>{
  const {context,rows}=stops(),result=context.dedupeStops(rows);
  const manukau=result.find(s=>s[4]===3 && s[3]==='Manukau Bus Station');
  assert.equal(manukau[6].platforms.length,11);
  assert.ok(result.some(s=>s[4]===3 && s[3].startsWith('Smales Farm')));
  assert.equal(result.filter(s=>s[4]===0 && s[3].includes('Manukau Rd/Green Ln W')).length,4);
  for(const bay of manukau[6].platforms){
    assert.equal(context.stopKeyById.get(bay.id),manukau[5]);
    assert.match(bay.label,/^Bay \d+$/);
    assert.ok(!result.some(s=>s[4]===0 && s[2]===bay.code));
  }
  // Same-named hubs with distinct AT parent IDs must keep every bay.
  const grouped=TransitData.groupBusStations(rows).filter(s=>s.type===3);
  assert.equal(result.filter(s=>s[4]===3).length,grouped.length);
  assert.equal(grouped.reduce((n,s)=>n+s.platforms.length,0)+result.filter(s=>s[4]===0).length,rows.length);
});
async function board(responses){
  const {context,rows}=stops(),station=context.dedupeStops(rows).find(s=>s[3]==='Manukau Bus Station');
  const requests=[],records=new Map();
  Object.assign(context,{navigator:{onLine:true},isPageVisible:()=>true,departuresByStation:records,
    departuresPending:new Map(),backoff:{departures:{until:0}},latestPlatformIds:new Map(),
    resolveStopKey:()=>null,departuresUrl:'/api/departures',refreshOpenStopPopup:()=>{},_openStopMarker:null,
    applyRateLimitBackoff:()=>{},parseRetryAfterMs:()=>60000,
    safeFetch:async url=>{requests.push(new URL(url,'http://local').searchParams.get('ids').split(','));return responses[requests.length-1];}});
  vm.runInContext(helper('loadStationDepartures'),context);
  await context.loadStationDepartures({_stopType:3,_stopKey:station[5],_stopInfo:station[6]});
  return {requests,record:records.get(station[5])};
}
test('bus station timetable queries every bay in bounded batches',async()=>{
  const {requests,record}=await board([{data:[{tripId:'first'}],complete:true},{data:[{tripId:'last'}],complete:true}]);
  assert.deepEqual(requests.map(r=>r.length),[8,3]);
  assert.equal(new Set(requests.flat()).size,11);
  assert.equal(record.data.length,2);
  assert.equal(record.complete,true);
});
test('failed later bay batch keeps successful departures and labels the board partial',async()=>{
  const {record}=await board([{data:[{tripId:'first'}],complete:true},null]);
  assert.equal(record.status,'ready');
  assert.equal(record.data[0].tripId,'first');
  assert.equal(record.complete,false);
  assert.ok(record.retryAt>Date.now());
});
