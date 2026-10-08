const {chromium}=require('playwright'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {Store,dateAt}=require('../performance/core.cjs'),{Collector}=require('../performance/collector.cjs'),{createServer}=require('../performance/server.cjs');
(async()=>{
 const store=new Store(':memory:'),collector=new Collector(store,{key:'fixture'}),api=createServer(store,collector),root=path.resolve(__dirname,'../dist/pages');
 collector.status.lastSuccess=new Date().toISOString();
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/json','.png':'image/png','.csv':'text/csv','.webmanifest':'application/manifest+json'};
 const site=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');if(!url.pathname.startsWith('/AT-track/')){res.writeHead(404).end();return;}const file=path.resolve(root,'.'+url.pathname.slice('/AT-track'.length).replace(/\/$/,'/index.html'));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);});
 await new Promise(r=>api.listen(0,'127.0.0.1',r));await new Promise(r=>site.listen(0,'127.0.0.1',r));
 const localApi=`http://127.0.0.1:${api.address().port}`,base=`http://127.0.0.1:${site.address().port}`,backend='https://at-route-performance.dazzlingfields.workers.dev';let browser;
 try{
  browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage(),errors=[];let privateCalls=0,cacheCalls=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route(backend+'/**',async route=>{
   const req=route.request(),url=new URL(req.url()),headers={'Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,PATCH'};
   if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
   if(url.pathname==='/api/network/routes'){cacheCalls++;assert.equal(req.headers().authorization,undefined);await route.fulfill({json:{data:[{id:'bus-route',attributes:{route_type:'3',route_short_name:'376',route_long_name:'Drury to Papakura'}}]},headers});return;}
   privateCalls++;if(req.headers().authorization!=='Basic '+Buffer.from('admin:test-pages').toString('base64')){await route.fulfill({status:401,body:'Sign in',headers});return;}
   const response=await fetch(localApi+url.pathname+url.search,{method:req.method(),headers:{'Content-Type':'application/json'},body:req.postData()||undefined});
   await route.fulfill({status:response.status,body:await response.text(),headers:{...headers,'Content-Type':response.headers.get('Content-Type')}});
  });
  await page.route('https://atrealtime.vercel.app/**',async route=>{const now=Math.floor(Date.now()/1000),endpoint=new URL(route.request().url()).pathname;let data={data:[]};if(endpoint==='/api/realtime')data={entity:[{vehicle:{timestamp:now,position:{latitude:-37.06,longitude:174.946,speed:1},vehicle:{id:'pages-bus',label:'Pages fixture'},trip:{route_id:'bus-route',trip_id:'pages-trip'}}}]};if(endpoint==='/api/tripupdates')data={response:{header:{timestamp:now},entity:[]}};if(endpoint==='/api/trips')data={data:[{attributes:{trip_id:'pages-trip',route_id:'bus-route',trip_headsign:'Papakura'}}]};await route.fulfill({json:data,headers:{'Access-Control-Allow-Origin':'*'}});});
  await page.goto(base+'/AT-track/next/');await page.frameLocator('#network-map').locator('#live-status[data-state=live]').waitFor({state:'attached'});
  assert.ok(cacheCalls>0,'Map uses Cloudflare route catalogue');assert.equal(privateCalls,0,'Public live view does not request private history or prompt login');assert.equal(await page.locator('#backend-dialog').isVisible(),false);
  await page.locator('.workspace-nav [data-view=overview]').click();await page.locator('#backend-dialog').waitFor();
  await page.locator('#backend-form [name=password]').fill('test-pages');await page.locator('#backend-form [type=submit]').click();await page.waitForFunction(()=>document.querySelectorAll('#route-cards .route-card').length===2);
  assert.equal(await page.evaluate(()=>localStorage.getItem('test-pages')),null);assert.ok(privateCalls>0);
  await page.getByRole('button',{name:'Add route',exact:false}).click();await page.locator('#route-form [name=code]').fill('70');await page.locator('#route-form [name=name]').fill('Pages route');await page.getByRole('button',{name:'Start tracking'}).click();await page.waitForFunction(()=>document.querySelectorAll('#route-cards .route-card').length===3);
  await page.locator('.workspace-nav [data-view=history]').click();const download=page.waitForEvent('download');await page.locator('#export').click();assert.equal((await download).suggestedFilename(),'route-performance.csv');
  const names=await page.evaluate(()=>Object.keys(localStorage));for(const name of names)assert.doesNotMatch(await page.evaluate(name=>localStorage.getItem(name),name),/test-pages|Basic /);
  assert.deepEqual(errors,[]);await context.close();console.log('GitHub Pages subfolder, public Cloudflare catalogue, private sign-in, route management and authenticated CSV export passed');
 }finally{await browser?.close();await new Promise(r=>site.close(r));await new Promise(r=>api.close(r));store.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
