const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function loadHandler(file, fetch, extra = {}) {
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout,
    process: { env: { AT_API_KEY: 'test' } }, ...extra });
  vm.runInContext(read(file).replace('export default async function handler', 'async function handler'), context);
  return context;
}
async function call(context, ids = 'shape') {
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(n) { this.code = n; return this; }, json(data) { this.data = data; return this; } };
  await context.handler({ method: 'GET', query: { ids } }, response);
  return response;
}
function reply(data, status = 200) {
  return { ok: status === 200, status, headers: { get: () => null },
    text: async () => JSON.stringify(data) };
}
const points = { data: [
  { attributes: { shape_pt_lat: -36, shape_pt_lon: 174, shape_pt_sequence: 1 } },
  { attributes: { shape_pt_lat: -37, shape_pt_lon: 175, shape_pt_sequence: 2 } },
] };

test('shape failure is not CDN cached and a later request can recover', async () => {
  let fail = true;
  const context = loadHandler('api/shapes.js', async () => fail ? reply({}, 503) : reply(points));
  const failed = await call(context);
  assert.equal(failed.headers['Cache-Control'], 'no-store');
  assert.equal(context.__AT_SHAPES__.size, 0);
  fail = false;
  const recovered = await call(context);
  assert.equal(recovered.data.shapes.shape.length, 2);
  assert.match(recovered.headers['Cache-Control'], /s-maxage=86400/);
});

test('failure on a later shape page never persists a partial route', async () => {
  let calls = 0;
  const context = loadHandler('api/shapes.js', async () => ++calls === 1
    ? reply({ ...points, links: { next: 'https://api.at.govt.nz/next' } }) : reply({}, 429));
  const response = await call(context);
  assert.equal(response.data.shapes.shape, null);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.equal(context.__AT_SHAPES__.size, 0);
});

test('shape pagination cap does not cache incomplete geometry', async () => {
  const context = loadHandler('api/shapes.js', async () => reply({ ...points,
    links: { next: 'https://api.at.govt.nz/next' } }));
  const response = await call(context);
  assert.match(response.data._diag.shape.error, /pagination limit/);
  assert.equal(context.__AT_SHAPES__.size, 0);
});

for (const file of ['api/realtime.js', 'api/tripupdates.js', 'api/shapes.js', 'api/routes.js','api/trips.js']) {
  test(`${file} aborts a response body stalled after headers`, async () => {
    const context = loadHandler(file, async (_url, { signal }) => ({
      ok: true, status: 200, headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
      }),
    }), { setTimeout: fn => setTimeout(fn, 5) });
    const response = await call(context);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    if (file.endsWith('shapes.js')) assert.match(response.data._diag.shape.error, /body aborted/);
    else if(file.endsWith('trips.js')) assert.match(response.data.errors.shape,/body aborted/);
    else assert.equal(response.code, 500);
  });
}

test('client backoff respects long Retry-After and does not shorten existing waits', () => {
  const source = read('script.js');
  const helper = source.match(/function applyRateLimitBackoff\([\s\S]*?\n\}/)[0];
  const context = vm.createContext({ backoff: { realtime: { ms: 0, until: 0 } },
    BACKOFF_START_MS: 15000, BACKOFF_MAX_MS: 120000, Date: { now: () => 1000 }, setDebug() {} });
  vm.runInContext(helper, context);
  context.applyRateLimitBackoff(60000, 'realtime');
  assert.equal(context.backoff.realtime.until, 61000);
  context.applyRateLimitBackoff(1000, 'realtime');
  assert.equal(context.backoff.realtime.until, 61000);
  assert.doesNotMatch(source, /__retryOnce/);
});

test('client skips failed shape lookups while retaining successful ones', async () => {
  const source = read('script.js');
  const helper = source.match(/async function fetchShapes\(ids\)\{[\s\S]*?\n\}/)[0];
  const ingested = [];
  const context = vm.createContext({ Date, backoff: { shapes: { until: 0 } },
    shapeCache: new Map(), shapePending: new Set(), shapesUrl: '/shapes',
    chunk: a => [a], safeFetch: async () => ({ shapes: { good: [[1, 2], [3, 4]], bad: null },
      _diag: { good: {}, bad: { error: '503' } } }),
    ingestShape: id => ingested.push(id), applyRateLimitBackoff() {} });
  vm.runInContext(helper, context);
  await context.fetchShapes(['good', 'bad']);
  assert.deepEqual(ingested, ['good']);
  assert.equal(context.shapePending.size, 0);
});

test('routes expose Retry-After across origins and do not cache rate-limit errors',async()=>{
  const context=loadHandler('api/routes.js',async()=>({ok:false,status:429,headers:{get:()=> '42'},text:async()=>''}));
  const response=await call(context);
  assert.equal(response.code,429);
  assert.equal(response.headers['Retry-After'],'42');
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.match(response.headers['Access-Control-Expose-Headers'],/Retry-After/);
});

test('trip partial failures keep successful metadata and are never CDN cached',async()=>{
  const context=loadHandler('api/trips.js',async url=>url.endsWith('/good')
    ?reply({data:{id:'good',attributes:{trip_id:'good',route_id:'rail'}}}):reply({},503));
  const response=await call(context,'good,bad');
  assert.equal(response.code,200);
  assert.equal(response.data.data[0].attributes.trip_id,'good');
  assert.match(response.data.errors.bad,/503/);
  assert.equal(response.headers['Cache-Control'],'no-store');
  assert.equal(context.__AT_TRIPS_PENDING__.size,0);
});

test('trip rate limits stop new batch work and reach the client retry policy',async()=>{
  let calls=0;
  const context=loadHandler('api/trips.js',async()=>{calls++;return {ok:false,status:429,headers:{get:()=> '30'},text:async()=>''};});
  const response=await call(context,Array.from({length:12},(_,i)=>String(i)).join(','));
  assert.equal(response.code,429);
  assert.ok(calls<=4);
  assert.equal(response.headers['Retry-After'],'30');
  assert.equal(Object.keys(response.data.errors).length,12);
});

test('departed vehicle is removed from mode groups as well as map and caches',()=>{
  const helper=read('script.js').match(/function removeVehicleMarker\([^]*?\n\}/)[0];
  const marker={},layerMembers=new Set([marker]);
  const context=vm.createContext({vehicleMarkers:{vehicle:marker},vehicleLayers:{train:{removeLayer:m=>layerMembers.delete(m)}},
    map:{removeLayer(){}},motionState:new Map([['vehicle',{}]]),activeTweens:new Map([['vehicle',{}]])});
  vm.runInContext(helper,context);
  context.removeVehicleMarker('vehicle');
  assert.equal(layerMembers.size,0);
  assert.equal(context.vehicleMarkers.vehicle,undefined);
  assert.equal(context.motionState.size,0);
  assert.equal(context.activeTweens.size,0);
});

test('reference asset timeout remains active through body parsing',async()=>{
  const helper=read('script.js').match(/async function fetchReferenceAsset\([^]*?\n\}/)[0];
  const context=vm.createContext({AbortController,clearTimeout,setTimeout:fn=>setTimeout(fn,5),
    fetch:async(_url,{signal})=>({ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stalled'))))})});
  vm.runInContext(helper,context);
  assert.equal(await context.fetchReferenceAsset('train_stations.geojson'),null);
});
