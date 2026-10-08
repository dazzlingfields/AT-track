const {test}=require('node:test'),assert=require('node:assert/strict');
test('Pages CORS permits only configured origin and explicit methods/headers',async()=>{
 const {preflight,withCors,allowedOrigin}=await import('../performance/cloud/pages-api.mjs');
 const env={PAGES_ORIGIN:'https://dazzlingfields.github.io'};
 const request=origin=>new Request('https://backend.test/api/routes',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'PATCH','Access-Control-Request-Headers':'authorization,content-type'}});
 assert.equal(preflight(request(env.PAGES_ORIGIN),env).status,204);
 assert.equal(preflight(request('https://other.github.io'),env).status,403);
 assert.equal(allowedOrigin(new Request('https://backend.test'),env),null);
 const result=withCors(new Response('private',{status:401,headers:{'Cache-Control':'no-store'}}),env.PAGES_ORIGIN);
 assert.equal(result.status,401);assert.equal(result.headers.get('Cache-Control'),'no-store');assert.equal(result.headers.get('Access-Control-Allow-Origin'),env.PAGES_ORIGIN);
});
test('public catalogue caches only AT reference rows, avoiding repeated D1 reads',async()=>{
 const {cachedCatalogue}=await import('../performance/cloud/pages-api.mjs');let reads=0;
 const catalogue={time:Date.now(),rows:[['route-376',{route_short_name:'376',route_type:3}]]};
 const env={DB:{prepare:()=>({bind:()=>({first:async()=>{reads++;return {value:JSON.stringify(catalogue)};}})})}};
 const entries=new Map(),cache={match:async key=>entries.get(key.url)?.clone(),put:async(key,response)=>entries.set(key.url,response.clone())};
 const request=new Request('https://backend.test/api/network/routes?ignored=1');
 const response=await cachedCatalogue(request,env,null,cache);assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/s-maxage=300/);
 assert.equal((await response.json()).data[0].attributes.route_short_name,'376');
 await cachedCatalogue(new Request('https://backend.test/api/network/routes'),env,null,cache);assert.equal(reads,1);
 catalogue.time=Date.now()-86400001;assert.equal((await cachedCatalogue(request,env,null,null)).status,503);
});
test('Pages origin does not bypass existing dashboard authentication',async()=>{
 const worker=(await import('../performance/cloud/worker.mjs')).default,env={DASHBOARD_PASSWORD:'test-only',PAGES_ORIGIN:'https://dazzlingfields.github.io'};
 const response=await worker.fetch(new Request('https://backend.test/api/routes',{headers:{Origin:env.PAGES_ORIGIN}}),env);
 assert.equal(response.status,401);assert.equal(response.headers.get('Access-Control-Allow-Origin'),env.PAGES_ORIGIN);
 const rejected=await worker.fetch(new Request('https://backend.test/api/routes',{method:'OPTIONS',headers:{Origin:'https://evil.test','Access-Control-Request-Method':'POST'}}),env);
 assert.equal(rejected.status,403);
});
