// Integration checks use a real in-memory report store and mocked AT live feeds.
// Run with Playwright available: node tests/workspace-browser.cjs
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Store,dateAt}=require('../performance/core.cjs');
const {Collector}=require('../performance/collector.cjs');
const {createServer}=require('../performance/server.cjs');
async function run(){
 const store=new Store(':memory:'),now=Math.floor(Date.now()/1000),date=dateAt(now);
 store.ingest({events:[0,60,400,null].map((delay,i)=>({routeId:1,tripId:'workspace-trip',serviceDate:date,startTime:'',stopId:String(1000+i),sequence:i+1,kind:'arrival',eventTime:now-30-i*60,scheduledTime:now-30-i*60-(delay||0),delaySec:delay,reportedAt:now})),cancellations:[]});
 store.archiveTimetables([{route_id:1,trip_id:'workspace-trip',service_date:date,captured_at:now,metadata_json:JSON.stringify({destination:'Papakura via Drury'}),stops_json:JSON.stringify([{sequence:1,stopId:'1000',name:'Drury',scheduledArrival:now-300,scheduledDeparture:now-280},{sequence:2,stopId:'2716-abcdef12',name:'Papakura Station',scheduledArrival:now-100,scheduledDeparture:now-90}])}]);
 const collector=new Collector(store,{key:'fixture'});collector.status.lastSuccess=new Date().toISOString();
 const server=createServer(store,collector);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`,url=base+'/next/';
 const folder=path.join(__dirname,'../.test-artifacts/workspace');fs.mkdirSync(folder,{recursive:true});
 let browser;
 try{
  const legacy=await fetch(base);assert.equal(legacy.status,200);assert.match(await legacy.text(),/Your connection/);
  const mapResponse=await fetch(url+'live/index.html');assert.equal(mapResponse.status,200);assert.match(mapResponse.headers.get('content-security-policy'),/frame-ancestors 'self'/);
  assert.equal((await fetch(base+'/next/%2e%2e%2fserver.cjs')).status,404);
  browser=await chromium.launch({channel:'chrome',headless:true});
  for(const width of [1440,390,320]){
   const context=await browser.newContext({viewport:{width,height:950},serviceWorkers:'block'}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   page.on('console',message=>{if(message.type()==='error'&&message.text().includes('Content Security Policy'))errors.push(message.text());});
   await page.route('https://atrealtime.vercel.app/**',async route=>{
    const endpoint=new URL(route.request().url()).pathname;let payload={data:[]};
    if(endpoint==='/api/routes')payload={data:[{id:'bus-route',attributes:{route_type:'3',route_short_name:'376',route_long_name:'Drury to Papakura'}},{id:'train-route',attributes:{route_type:'2',route_short_name:'S-C',route_long_name:'South City'}}]};
    if(endpoint==='/api/realtime')payload={entity:[{vehicle:{timestamp:Math.floor(Date.now()/1000),position:{latitude:-37.06495,longitude:174.9463,speed:4},vehicle:{id:'workspace-bus',label:'NB1001'},trip:{route_id:'bus-route',trip_id:'workspace-trip',start_date:date.replaceAll('-','')}}},{trip_update:{trip:{trip_id:'workspace-trip',route_id:'bus-route'},timestamp:Math.floor(Date.now()/1000),stop_time_update:{stop_id:'2716-abcdef12',stop_sequence:2,arrival:{time:Math.floor(Date.now()/1000)-5,delay:120}}}}]};
    if(endpoint==='/api/trips')payload={data:[{attributes:{trip_id:'workspace-trip',route_id:'bus-route',trip_headsign:'Papakura via Drury'}}]};
    if(endpoint==='/api/tripupdates')payload={response:{header:{timestamp:Math.floor(Date.now()/1000)},entity:[]}};
    if(endpoint==='/api/departures')payload={complete:true,generatedAt:now,timezone:'Pacific/Auckland',data:[]};
    await route.fulfill({json:payload,headers:{'Access-Control-Allow-Origin':'*'}});
   });
   const nav=async view=>page.locator(`.workspace-nav [data-view="${view}"]`).click();
   await page.goto(url,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelectorAll('#route-cards .route-card').length===2);
   const map=page.frameLocator('#network-map');await map.locator('#live-status[data-state="live"]').waitFor({state:'attached'});
   assert.equal(await page.locator('#live-workspace').isVisible(),true);
   assert.equal(await page.locator('#filters').isVisible(),false);
   assert.equal(await page.locator('#service-workspace').isVisible(),false);
   assert.equal(await page.locator('.workspace-heading').isVisible(),false);
   const fullMap=await page.locator('#network-map').boundingBox();
   assert.ok(fullMap.height>=950-(width<=700?58:0)-1,'Live map should fill available viewport height');
   assert.ok(fullMap.width>=width-(width<=700?0:222)-1,'Live map should fill available viewport width');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true,'Live page must not scroll');
   await nav('overview');assert.match(await page.locator('#route-cards').textContent(),/66\.7%/);
   await page.locator('#route-cards .route-card').first().getByRole('button',{name:'Show live vehicles'}).click();
   await page.waitForFunction(()=>document.querySelector('#selected-service').textContent.includes('NB1001'));
   assert.match(await page.locator('#selected-service').textContent(),/2\.0 min late/);
   assert.match(await page.locator('#selected-service').textContent(),/Unknown/);
   await page.screenshot({path:path.join(folder,'live-'+width+'.png'),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   // Forged window messages cannot impersonate the map.
   await page.evaluate(()=>window.postMessage({source:'at-track-map',type:'selection',vehicle:{vehicle:'FORGED'}},location.origin));
   assert.doesNotMatch(await page.locator('#selected-service').textContent(),/FORGED/);
   await map.getByRole('button',{name:'View service details'}).click();
   await page.waitForFunction(()=>document.body.dataset.view==='service');
   assert.equal(await page.locator('#service-workspace').isVisible(),true);
   assert.equal(await page.locator('#live-workspace').isVisible(),false);
   await page.locator('#selected-service').getByRole('button',{name:'View recorded trip'}).click();
   await page.waitForFunction(()=>document.body.dataset.view==='route'&&document.querySelectorAll('#trip-stops .trip-stop').length>=2).catch(async error=>{console.log(await page.evaluate(()=>({view:document.body.dataset.view,trip:document.querySelector('#trip-choice').value,coverage:document.querySelector('#trip-coverage').textContent,errors:document.querySelector('#notice').textContent})));await page.screenshot({path:path.join(folder,'trip-failure.png'),fullPage:true});throw error;});
   assert.match(await page.locator('#trip-heading').textContent(),/workspace-trip/);
   assert.equal(await page.locator('.trip-endpoint').count(),2);
   assert.match(await page.locator('.trip-endpoint').first().textContent(),/Start departure.*Drury.*Not captured/);
   assert.match(await page.locator('.trip-endpoint').last().textContent(),/End arrival.*Papakura/);
   assert.equal(await map.locator('body').evaluate(()=>window.atWorkspaceVisible),false);
   assert.equal(await page.locator('#route-hour-chart .hour-button').count(),24);
   await page.locator('#route-hour-mode').selectOption('delay');assert.equal(await page.locator('#route-hour-chart svg').count(),1);
   await page.screenshot({path:path.join(folder,'route-'+width+'.png'),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.locator('#route-context').getByRole('button',{name:'Show live vehicles'}).click();
   await page.waitForFunction(()=>document.body.dataset.view==='live');
   assert.equal(await map.locator('body').evaluate(()=>window.atWorkspaceVisible),true);
   await page.getByRole('button',{name:'Ferries',exact:true}).click();
   await map.locator('input[data-layer=ferry]').evaluate(input=>{if(input.checked)throw Error('Layer chip did not reach map');});
   // Historical filters stay on report pages and never intrude on the full map.
   await nav('overview');await page.getByRole('button',{name:'Yesterday',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('#observations').textContent==='0');await nav('live');
   assert.equal(await page.locator('#filters').isVisible(),false);
   for(const view of ['service','overview','transfers','services','stops','history','occupancy','trips','settings']){
    await nav(view);await page.waitForFunction(view=>document.body.dataset.view===view,view);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,view+' overflows at '+width);
   }
   await page.locator('#late').fill('0');await page.getByRole('button',{name:'Update window'}).click();
   await nav('overview');await page.getByRole('button',{name:'Today',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#otp').textContent==='33.3%');
   await page.getByRole('button',{name:'Pause Route 376',exact:true}).click();await page.getByRole('button',{name:'Resume Route 376',exact:true}).waitFor();
   await page.getByRole('button',{name:'Resume Route 376',exact:true}).click();await page.getByRole('button',{name:'Pause Route 376',exact:true}).waitFor();
   await nav('history');const exported=await fetch(base+new URL(await page.locator('#export').getAttribute('href'),base).pathname+'?'+new URL(await page.locator('#export').getAttribute('href'),base).searchParams);assert.match(await exported.text(),/workspace-trip/);
   await page.reload();await page.waitForFunction(()=>document.body.dataset.view==='history');
   await nav('settings');await page.locator('#late').fill('5');await page.getByRole('button',{name:'Update window'}).click();
   await nav('live');await map.locator('#live-status[data-state="live"]').waitFor({state:'attached'});
   // Offline explicitly replaces live delay evidence, rather than retaining a fresh label.
   await nav('overview');await page.locator('#route-cards .route-card').first().getByRole('button',{name:'Show live vehicles'}).click();
   await context.setOffline(true);await page.waitForFunction(()=>document.querySelector('#map-state').dataset.state==='offline');
   await nav('service');
   assert.match(await page.locator('#selected-service').textContent(),/Unavailable/);await context.setOffline(false);
   assert.deepEqual(errors,[]);await context.close();console.log('Combined workspace interactions passed at '+width+'px');
  }
  const offlineContext=await browser.newContext({viewport:{width:390,height:844}}),offlinePage=await offlineContext.newPage();
  await offlinePage.goto(url+'#settings');
  await offlinePage.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await offlinePage.waitForFunction(()=>navigator.serviceWorker.controller!==null);
  const cached=await offlinePage.evaluate(async()=>{const results=[];for(const name of await caches.keys()){const cache=await caches.open(name);results.push(...(await cache.keys()).map(r=>r.url));}return results;});
  assert.equal(cached.some(u=>new URL(u).pathname.startsWith('/api/')),false,'Private APIs must never be cached');
  assert.equal(cached.some(u=>new URL(u).pathname==='/next/'),true);
  assert.equal(cached.some(u=>u==='https://unpkg.com/leaflet@1.7.1/dist/leaflet.js'),true,'Map library is available offline');
  await offlineContext.setOffline(true);await offlinePage.reload();await offlinePage.waitForFunction(()=>document.body.dataset.view==='settings');
  await offlinePage.waitForFunction(()=>document.querySelector('#connection').textContent==='Dashboard disconnected');
  assert.equal(await offlinePage.locator('#thresholds').isVisible(),true);
  await offlinePage.locator('.workspace-nav [data-view=live]').click();
  await offlinePage.frameLocator('#network-map').locator('#live-status[data-state=offline]').waitFor({state:'attached'});
  await offlineContext.close();console.log('Installable app shell reloads offline; private reports and live APIs remain uncached');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
