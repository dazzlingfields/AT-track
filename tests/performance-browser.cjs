// Run with Playwright available (the Codex bundled runtime provides it).
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Store,dateAt}=require('../performance/core.cjs');
const {Collector}=require('../performance/collector.cjs');
const {createServer}=require('../performance/server.cjs');
(async()=>{
  const store=new Store(':memory:'),now=Date.now()/1000,date=dateAt(now);
  store.ingest({events:Array.from({length:12},(_,i)=>({routeId:i<6?1:2,tripId:`trip-${i}`,serviceDate:date,startTime:'',stopId:`${1000+i}`,sequence:1,kind:'arrival',eventTime:now-i*60,scheduledTime:now-i*60-([0,50,400,-90,null,180][i%6]??0),delaySec:[0,50,400,-90,null,180][i%6],reportedAt:now})),cancellations:[{routeId:1,tripId:'cancelled',serviceDate:date,startTime:'',reportedAt:now}]});
  store.saveOccupancy([{route_id:1,trip_id:'b',service_date:date,start_time:'',vehicle_id:'v',sample_bucket:Math.floor(now/300),sample_time:now,occupancy_status:1,occupancy_percentage:null},{route_id:2,trip_id:'t',service_date:date,start_time:'',vehicle_id:'tr',sample_bucket:Math.floor(now/300),sample_time:now,occupancy_status:2,occupancy_percentage:50}]);
  store.archiveTimetables([{route_id:1,trip_id:'trip-5',service_date:date,captured_at:now,metadata_json:JSON.stringify({destination:'Papakura via Drury',source:'Fixture GTFS'}),stops_json:JSON.stringify([{sequence:3,stopId:'2716-abcdef12',name:'Papakura Station',scheduledArrival:now-2410,scheduledDeparture:now-2400},{sequence:15,stopId:'1002',name:'Drury',scheduledArrival:now-1200,scheduledDeparture:now-1180},{sequence:31,stopId:'2716-abcdef12',name:'Papakura Station',scheduledArrival:now-680,scheduledDeparture:now-660}])}]);
  const collector=new Collector(store,{key:'fixture'});collector.status.lastSuccess=new Date().toISOString();
  store.db.prepare("UPDATE events SET stop_id='2716-abcdef12',sequence=31,event_time=?,scheduled_time=? WHERE trip_id='trip-5'").run(now-480,now-660);
  store.db.prepare("UPDATE events SET stop_id='9230-abcdef12',sequence=4 WHERE trip_id='trip-6'").run();
  store.saveSchedules([{route_id:1,trip_id:'trip-5',service_date:date,stop_id:'2716-abcdef12',stop_code:'2716',sequence:3,scheduled_time:now-2400,destination:'Drury',pickup_type:0,seen_at:now},
    {route_id:1,trip_id:'trip-5',service_date:date,stop_id:'2716-abcdef12',stop_code:'2716',sequence:31,scheduled_time:now-660,destination:'Papakura',pickup_type:0,seen_at:now},
    {route_id:2,trip_id:'trip-6',service_date:date,stop_id:'9230-abcdef12',stop_code:'9230',sequence:4,scheduled_time:now-360,destination:'City Centre via Grafton',pickup_type:0,seen_at:now}]);
  store.ingest({events:[{routeId:2,tripId:'trip-6',serviceDate:date,startTime:'',stopId:'9230-abcdef12',sequence:4,kind:'departure',eventTime:now-330,scheduledTime:now-360,delaySec:30,reportedAt:now}],cancellations:[]});
  store.savePositions([[-500,110],[-480,3],[-460,4],[-440,120]].map(([offset,metres])=>({route_id:1,trip_id:'trip-5',service_date:date,start_time:'',vehicle_id:'v',vehicle_label:'Fixture bus',position_time:now+offset,latitude:-37.06495+metres/111195,longitude:174.9463,distance:metres,progress_sequence:31})));
  store.setState('positions',{lastSuccess:new Date().toISOString(),error:null,vehicles:[{vehicle_label:'Fixture bus',start_time:'',distance:3,position_time:now}]});
  store.setState('timetable',{lastAttempt:new Date().toISOString(),lastSuccess:new Date().toISOString(),complete:true,error:null});
  const server=createServer(store,collector);await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
  const folder=path.join(__dirname,'../.test-artifacts/performance');fs.mkdirSync(folder,{recursive:true});let browser;
  try{
    browser=await chromium.launch({channel:'chrome',headless:true});
    for(const width of [1440,390,320]){
      const context=await browser.newContext({viewport:{width,height:950}}),page=await context.newPage(),errors=[];
      const navigation=async name=>{if(!['Your routes','Papakura connections'].includes(name))await page.locator('.tools-menu summary').click();await page.locator('.page-nav').getByRole('button',{name,exact:true}).click();};
      page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>document.querySelector('#observations').textContent==='12');
      assert.equal(await page.locator('.route-card').count(),2);assert.equal(await page.locator('#otp').textContent(),'60.0%');
      await page.waitForFunction(()=>document.querySelector('#transfer-rate').textContent==='100.0%');
      assert.equal(await page.locator('#stop-performance tr').count(),12);assert.match(await page.locator('#transfer-events').textContent(),/GPS: 2 dwell readings/);assert.match(await page.locator('#station-vehicles').textContent(),/Fixture bus/);
      assert.match(await page.locator('#stop-performance').textContent(),/Papakura Station/);
      assert.match(await page.locator('#service-extremes').textContent(),/6.7 min late/);
      assert.match(await page.locator('#service-extremes').textContent(),/1.5 min early/);
      assert.equal(await page.evaluate(()=>{const a=document.querySelector('#route-overview').getBoundingClientRect(),b=document.querySelector('#transfers').getBoundingClientRect(),c=document.querySelector('#day-services').getBoundingClientRect();return b.top>=a.bottom&&c.top>=b.bottom;}),true);
      assert.equal(await page.locator('#events').isVisible(),false);
      await navigation('Service rankings');await page.locator('#service-extremes button').first().click();
      await page.waitForFunction(()=>document.querySelector('#observations').textContent==='1');assert.equal(await page.locator('#trip-choice').isVisible(),true);await navigation('History');assert.equal(await page.locator('#events').isVisible(),true);
      await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.locator('#route').selectOption('0');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='12');
      await page.locator('#filters [name=q]').fill('Papakura');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='2');
      await page.getByRole('button',{name:'Clear search',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='12');
      await page.getByRole('button',{name:'Yesterday',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='0');
      await page.getByRole('button',{name:'Today',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='12');
      await page.getByRole('button',{name:'Papakura connections',exact:true}).click();assert.equal(await page.locator('#transfer-search').isVisible(),true);
      await page.locator('#transfer-result').selectOption('missed');await page.getByRole('button',{name:'Search transfers',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#transfer-events').children.length===0);assert.equal(await page.locator('#transfer-rate').textContent(),'100.0%');
      await page.locator('#clear-transfer-search').click();await page.waitForFunction(()=>document.querySelector('#transfer-events').children.length===1);
      await page.locator('#transfer-connection').selectOption('train-bus');assert.equal(await page.locator('#transfer-window').isVisible(),true);await page.getByRole('button',{name:'Recalculate transfers'}).click();await page.waitForFunction(()=>document.querySelector('#transfer-title').textContent.includes('South City → 376'));assert.equal(await page.locator('#transfer-window').inputValue(),'10');
      await page.locator('#transfer-connection').selectOption('bus-train');await page.getByRole('button',{name:'Recalculate transfers'}).click();await page.waitForFunction(()=>document.querySelector('#transfer-rate').textContent==='100.0%');
      await page.locator('#walk').fill('0.5');assert.equal(await page.locator('#walk').evaluate(el=>el.checkValidity()),false);
      await page.locator('#walk').fill('5');await page.getByRole('button',{name:'Recalculate transfers'}).click();await page.waitForFunction(()=>document.querySelector('#transfer-rate').textContent==='0.0%');
      await page.locator('#walk').fill('2');await page.getByRole('button',{name:'Recalculate transfers'}).click();await page.waitForFunction(()=>document.querySelector('#transfer-rate').textContent==='100.0%');
      await navigation('Stops');assert.equal(await page.locator('#stop-performance').isVisible(),true);
      await navigation('Occupancy');await page.waitForFunction(()=>document.querySelector('#occupancy-routes').children.length===2);assert.match(await page.locator('#occupancy-routes').textContent(),/Many seats available/);assert.match(await page.locator('#occupancy-routes').textContent(),/50.0%/);assert.equal(await page.locator('#filters [name=kind]').isVisible(),false);await page.screenshot({path:path.join(folder,'occupancy-'+width+'.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.getByRole('button',{name:'Your routes',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#transfer-rate').textContent==='100.0%');
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)){console.log(await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>!e.closest('[hidden]')&&e.getBoundingClientRect().right>innerWidth+1).map(e=>({tag:e.tagName,id:e.id,class:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})).slice(0,12)));await page.screenshot({path:path.join(folder,'overflow-route-'+width+'.png'),fullPage:true});}
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(folder,`dashboard-${width}.png`),fullPage:true});
      await page.getByRole('button',{name:'Add route',exact:false}).click();await page.locator('[name=code]').fill(String(width));await page.locator('[name=name]').fill(`Test route ${width}`);await page.getByRole('button',{name:'Start tracking'}).click();
      await page.waitForFunction(()=>!document.querySelector('#route-dialog').open);
      await page.getByRole('button',{name:'Pause Route 376',exact:true}).click();await page.getByRole('button',{name:'Resume Route 376',exact:true}).waitFor();
      await page.getByRole('button',{name:'Resume Route 376',exact:true}).click();await page.getByRole('button',{name:'Pause Route 376',exact:true}).waitFor();
      await page.locator('#route').selectOption('2');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='6');
      assert.equal(await page.locator('.route-card').count(),1);
      await page.getByText('How performance is measured & settings',{exact:true}).click();await page.locator('#late').fill('0');await page.getByRole('button',{name:'Update window'}).click();await page.waitForFunction(()=>document.querySelector('#otp').textContent==='20.0%');
      await navigation('History');
      await page.locator('[name=kind]').selectOption('departure');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='1');
      await page.locator('#route').selectOption('1');await page.getByRole('button',{name:'Apply',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#observations').textContent==='0');assert.equal(await page.locator('#empty').isVisible(),true);
      await page.goto(url+'#stops');await page.reload();await page.waitForFunction(()=>document.querySelector('#stop-performance').children.length>0);assert.equal(await page.locator('#stop-performance').isVisible(),true);
      await navigation('Trip explorer');await page.locator('#trip-search').fill('trip-5');await page.waitForFunction(()=>document.querySelector('#trip-choice').options.length===2);await page.locator('#trip-choice').selectOption({label:(await page.locator('#trip-choice option').allTextContents())[1]});await page.waitForFunction(()=>document.querySelectorAll('#trip-stops .trip-stop').length===3);assert.equal(await page.locator('#trip-stops .trip-stop').count(),3);assert.ok((await page.locator('#trip-stops').innerText()).includes('Visit 2'));assert.ok((await page.locator('#trip-stops').innerText()).includes('Not captured'));assert.ok((await page.locator('#trip-coverage').innerText()).includes('Full GTFS stop list'));await page.screenshot({path:path.join(folder,'trip-explorer-'+width+'.png'),fullPage:true});
      await page.getByRole('button',{name:'Papakura connections',exact:true}).click();await page.getByRole('button',{name:'View bus trip',exact:true}).first().click();await page.waitForFunction(()=>document.body.dataset.view==='route'&&document.querySelectorAll('#trip-stops .trip-stop').length===3);assert.ok((await page.locator('#trip-heading').innerText()).includes('trip-5'));
      await page.locator('#back-routes').click();await page.getByRole('button',{name:'View Route 376 performance',exact:true}).click();await page.waitForFunction(()=>document.body.dataset.view==='route'&&document.querySelector('#route-context-name').textContent==='Route 376'&&document.querySelector('#observations').textContent==='6');assert.equal(await page.locator('#trip-choice').isVisible(),true);assert.equal(await page.locator('.route-expander').first().getAttribute('open'),null);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(folder,'route-detail-'+width+'.png'),fullPage:true});await page.reload();await page.waitForFunction(()=>document.querySelector('#route-context-name').textContent==='Route 376');assert.equal(await page.locator('#route').inputValue(),'1');
      assert.equal(await page.locator('#route-hour-chart .hour-button').count(),24);await page.locator('#route-hour-chart .hour-button').nth(18).click();assert.ok((await page.locator('#route-hour-detail').textContent()).includes('18:00'));await page.locator('#route-hour-mode').selectOption('delay');assert.equal(await page.locator('#route-hour-chart svg').count(),1);await page.screenshot({path:path.join(folder,'route-chart-'+width+'.png'),fullPage:true});await page.getByRole('button',{name:'Papakura connections',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('#transfer-hour-chart .hour-button').length===24);await page.locator('#transfer-hour-chart .hour-button').nth(18).click();assert.ok((await page.locator('#transfer-hour-detail').textContent()).includes('18:00'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(folder,'transfer-chart-'+width+'.png'),fullPage:true});
      assert.deepEqual(errors,[]);await context.close();store.db.prepare('DELETE FROM routes WHERE code=?').run(String(width));console.log(`Dashboard interactions passed at ${width}px`);
    }
  }finally{await browser?.close();await new Promise(r=>server.close(r));store.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
