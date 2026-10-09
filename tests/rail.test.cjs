const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {simplify,metrePoint,segmentDistance,condenseStations}=require('../scripts/condense-rail.cjs');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const source=read('script.js');
const helper=name=>source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0];

test('rail simplification preserves endpoints and bends within 2.1 m including rounding',()=>{
  const points=Array.from({length:300},(_,i)=>[174.76+i*0.00001,-36.85+Math.sin(i/20)*0.0001]);
  const result=simplify(points);
  assert.ok(result.length<points.length/3);
  assert.deepEqual(result[0],points[0]);
  assert.deepEqual(result.at(-1),points.at(-1).map(n=>+n.toFixed(6)));
  const segments=result.map(metrePoint);
  for(const p of points.map(metrePoint)) assert.ok(Math.min(...segments.slice(1).map((b,i)=>segmentDistance(p,segments[i],b)))<=2.1);
});

test('both CRL lines retain the central tunnel geometry and new stations',()=>{
  const routes=JSON.parse(read('train_routes.geojson'));
  assert.equal(routes.features.length,4);
  for(const code of ['S-C','E-W']){
    const feature=routes.features.find(f=>f.properties.ROUTENUMBER===code);
    const points=feature.geometry.type==='LineString'?feature.geometry.coordinates:feature.geometry.coordinates.flat();
    assert.ok(points.filter(p=>p[0]>174.755&&p[0]<174.765&&p[1]>-36.86&&p[1]<-36.845).length>10,code);
  }
  const stations=JSON.parse(read('train_stations.geojson'));
  for(const name of ['Te Waihorotiu','Karanga-a-Hape','Maungawhau']) assert.ok(stations.features.some(f=>f.properties.STOPNAME.startsWith(name)));
  assert.equal(new Set(stations.features.map(f=>f.properties.PARENTSTATION)).size,stations.features.length);
  assert.equal(stations.features.reduce((n,f)=>n+f.properties.platforms.length,0),101);
});

test('new station geometry keeps platform IDs and legacy CSV IDs in the same arrivals group',()=>{
  const context=vm.createContext({stopById:new Map(),stopKeyById:new Map(),stopNameByKey:new Map(),TransitData:require('../transit-data.js')});
  vm.runInContext(helper('parseTrainStations')+'\n'+helper('dedupeStops'),context);
  const rows=context.parseTrainStations(JSON.parse(read('train_stations.geojson')));
  const original=rows.find(s=>s.name.startsWith('Te Waihorotiu'));
  const legacy={...original,parent:'',id:'legacy-platform',code:'old',platforms:undefined,lat:0,lon:0};
  const stops=context.dedupeStops([...rows,legacy]);
  const station=stops.find(s=>s[3]===original.name);
  assert.equal(stops.filter(s=>s[3]===original.name).length,1);
  assert.equal(station[0],original.lat);
  for(const p of original.platforms) assert.equal(context.stopKeyById.get(p.id),station[5]);
  assert.equal(context.stopKeyById.get('legacy-platform'),station[5]);
});

test('station compaction preserves available descriptions and averages platforms',()=>{
  const data=condenseStations({features:[1,2].map(i=>({properties:{STOPNAME:`Example Train Station ${i}`,
    PARENTSTATION:'parent',STOPID:`id${i}`,STOPCODE:i,STOPDESC:i===1?'Entrance on Main Road':null},
    geometry:{coordinates:[174+i*0.0001,-36]}}))});
  assert.equal(data.features.length,1);
  assert.equal(data.features[0].properties.platforms[0].description,'Entrance on Main Road');
  assert.deepEqual(data.features[0].geometry.coordinates,[174.00015,-36]);
});

test('station popup escapes source text and includes platform info and arrivals',()=>{
  const context=vm.createContext({STOP_STYLE:{1:{label:'Rail station'}},buildIntercityBoard:()=>'',isIntercityOnly:()=>false,stationHistoryHtml:()=>'',buildStationDepartureBoard:()=>'<div>Next services</div>'});
  vm.runInContext(source.match(/function escapeHtml[^\r\n]+/)[0]+'\n'+helper('buildStopPopup'),context);
  const html=context.buildStopPopup({_stopType:1,_stopName:'<Station>',_stopInfo:{platforms:[
    {name:'<Station> 1',code:'9001',description:'<script>alert(1)</script>'}]},getLatLng:()=>({lat:-36.85,lng:174.76})});
  assert.match(html,/&lt;Station&gt;/);
  assert.match(html,/9001/);
  assert.match(html,/Next services/);
  assert.doesNotMatch(html,/<script>/);
});

test('compact and hyphenated train line codes share the same colours',()=>{
  const context=vm.createContext({});
  vm.runInContext(helper('resolveTrainLineCode'),context);
  for(const [a,b] of [['SC','S-C'],['EW','E-W'],['OW','O-W']]) assert.equal(context.resolveTrainLineCode(a),context.resolveTrainLineCode(b));
});
