// Run with Playwright installed: node tests/browser-smoke.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const ScheduleData=require('../schedule-data.js');
const root = path.resolve(__dirname, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.geojson': 'application/json', '.csv': 'text/csv', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', e => { errors.push(e.message); console.error('Browser error:',e.message); });
      page.on('requestfailed', req => {
        if(req.failure()?.errorText!=='net::ERR_ABORTED') console.error('Failed request:',req.url(),req.failure()?.errorText);
      });
      page.on('request', req => requests.push(req.url()));
      await page.route('https://atrealtime.vercel.app/**', async route => {
        const endpoint = new URL(route.request().url()).pathname;
        let payload = { data: [] };
        if (endpoint === '/api/routes') {
          await new Promise(resolve => setTimeout(resolve, 700));
          payload = { data: [{ id: 'bus-route', attributes: {
            route_type: '3', route_short_name: '70', route_long_name: 'Britomart to Botany' } },
            {id:'rail-route',attributes:{route_type:'2',route_short_name:'E-W',route_long_name:'East-West Line'}}] };
        } else if (endpoint === '/api/realtime') {
          payload = { entity: [{ vehicle: { timestamp: Math.floor(Date.now() / 1000),
            position: { latitude: -36.8485, longitude: 174.7633, speed: 0 },
            vehicle: { id: 'test-bus', label: 'NB1001' },
            trip: { route_id: 'bus-route', trip_id: 'test-trip' } } },
            {vehicle:{position:{latitude:null,longitude:174},vehicle:{id:'invalid'},trip:{route_id:'bus-route'}}},
            // No rail vehicle exists: station boards must use trip updates independently.
            {trip_update:{trip:{trip_id:'legacy-train',route_id:'rail-route'},timestamp:Math.floor(Date.now()/1000),
              stop_time_update:{stop_id:'9297-abcdef99',stop_sequence:1,arrival:{time:Math.floor(Date.now()/1000)+180}}}},
            {trip_update:{trip:{trip_id:'future-train',route_id:'rail-route'},timestamp:Math.floor(Date.now()/1000),
              stop_time_update:[{stop_id:'9298-abcdef99',stop_sequence:1,arrival:{time:Math.floor(Date.now()/1000)+300}},
                {stop_id:'9406-abcdef99',stop_sequence:2,arrival:{time:Math.floor(Date.now()/1000)+600}}]}},
            {trip_update:{trip:{trip_id:'canceled-train',route_id:'rail-route',schedule_relationship:3},timestamp:Math.floor(Date.now()/1000)}}],
            header: { timestamp: Math.floor(Date.now() / 1000) } };
          const reportTime=Math.floor(Date.now()/1000);
          payload.entity.push({trip_update:{trip:{trip_id:'delayed-train',route_id:'rail-route',start_date:ScheduleData.dateString(ScheduleData.parts(reportTime))},timestamp:reportTime,
            stop_time_update:{stop_id:'9406-abcdef99',stop_sequence:2,departure:{time:reportTime-30,delay:180}}}});
          if(viewport.width===320) payload.entity=payload.entity.filter(e=>!e.trip_update);
        } else if (endpoint === '/api/departures') {
          await new Promise(resolve=>setTimeout(resolve,600));
          const now=Math.floor(Date.now()/1000),serviceDate=ScheduleData.dateString(ScheduleData.parts(now));
          payload={complete:true,invalidTimeCount:0,errors:[],generatedAt:now,timezone:'Pacific/Auckland',data:[
            {tripId:'legacy-train',serviceDate,stopId:'9297-abcdef99',sequence:1,routeId:'rail-route',destination:'Swanson',scheduledTime:now+120},
            {tripId:'future-train',serviceDate,stopId:'9298-abcdef99',sequence:1,routeId:'rail-route',destination:'Manukau',scheduledTime:now+240},
            {tripId:'scheduled-only',serviceDate,stopId:'9297-abcdef99',sequence:4,routeId:'rail-route',destination:'Henderson',scheduledTime:now+600},
            {tripId:'delayed-train',serviceDate,stopId:'9297-abcdef99',sequence:3,routeId:'rail-route',destination:'Delayed Swanson',scheduledTime:now+660},
            {tripId:'canceled-train',serviceDate,stopId:'9298-abcdef99',sequence:1,routeId:'rail-route',destination:'Cancelled destination',scheduledTime:now+450}
          ]};
          const ids=new URL(route.request().url()).searchParams.get('ids').split(',');
          if(!ids.some(id=>/^929[78]-/.test(id))) payload.data=ids.map((stopId,i)=>({tripId:`bus-${stopId}`,serviceDate,
            stopId,sequence:1,routeId:'bus-route',destination:'Botany',scheduledTime:now+180+i*60}));
        } else if (endpoint === '/api/trips') {
          // Slow metadata must not leave the refresh button disabled.
          await new Promise(resolve => setTimeout(resolve, 1800));
          const ids=new URL(route.request().url()).searchParams.get('ids').split(',');
          payload = { data: ids.map(id=>({attributes:{trip_id:id,route_id:id==='test-trip'?'bus-route':'rail-route',
            trip_headsign:id==='test-trip'?'Botany':id==='legacy-train'?'Swanson':'Manukau'}})) };
        } else if (endpoint === '/api/tripupdates') {
          await new Promise(resolve=>setTimeout(resolve,3000));
          const now=Math.floor(Date.now()/1000);
          payload = {response:{header:{timestamp:now},entity:[
            {trip_update:{trip:{trip_id:'legacy-train',route_id:'rail-route'},timestamp:now,
              stop_time_update:{stop_id:'9297-abcdef99',stop_sequence:1,arrival:{time:now+180}}}},
            {trip_update:{trip:{trip_id:'future-train',route_id:'rail-route'},timestamp:now,
              stop_time_update:[{stop_id:'9298-abcdef99',stop_sequence:1,arrival:{time:now+300}},
                {stop_id:'9406-abcdef99',stop_sequence:2,arrival:{time:now+600}}]}},
            {trip_update:{trip:{trip_id:'canceled-train',route_id:'rail-route',schedule_relationship:3},timestamp:now}}
          ]}};
        }
        await route.fulfill({ json: payload, headers: { 'Access-Control-Allow-Origin': '*' } });
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-count="bus"]').waitFor({ state: 'attached' });
      if (viewport.width < 600) await page.locator('#controls-toggle').click();
      await page.locator('input[data-layer="ferry"]').uncheck();
      await page.locator('#live-status[data-state="live"]').waitFor();
      assert.equal(await page.locator('[data-count="bus"]').textContent(), '1');
      assert.equal(await page.locator('#refresh-vehicles').isEnabled(), true);
      if(viewport.width===320) assert.equal(await page.evaluate(()=>tripUpdatesInFlight),true,'Fallback must not block live positions');
      assert.equal(requests.some(u => u.endsWith('/bus_routes.geojson')), false);
      assert.equal(requests.some(u => u.includes('turf.min.js')), false);
      assert.equal(requests.some(u=>u.includes('/api/departures')),false,'Timetables should load only on station selection');
      await page.waitForFunction(()=>stopsData.some(s=>s[3].startsWith('Te Waihorotiu')) && railLinesLayer?.getLayers().length===4);
      await page.waitForFunction(()=>arrivalsDiagnostics.entries>=2);
      await page.evaluate(()=>map.setView([-36.84944,174.763075],15,{animate:false}));
      const station=page.locator('.rail-station-icon[title="Te Waihorotiu Train Station"]');
      await station.waitFor();
      // Close the expanded mobile controls before tapping the map.
      if(viewport.width<600) await page.locator('#controls-toggle').click();
      await station.click();
      await page.locator('.leaflet-popup-content').waitFor();
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Te Waihorotiu Train Station/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Platforms \/ stop codes/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Next services/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/E-W/);
      await page.waitForFunction(()=>document.querySelector('.leaflet-popup-content')?.textContent.includes('Manukau'));
      await page.waitForFunction(()=>document.querySelector('.leaflet-popup-content')?.textContent.includes('Scheduled'));
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Henderson/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Live/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Cancelled/);
      if(viewport.width!==320){
        assert.match(await page.locator('.leaflet-popup-content').textContent(),/Average delay: 3m late/);
        assert.match(await page.locator('.leaflet-popup-content').textContent(),/1 of 4 upcoming services · 1 estimated/);
        assert.match(await page.locator('.leaflet-popup-content').textContent(),/Estimated/);
        assert.match(await page.locator('.leaflet-popup-content').textContent(),/Sched\./);
      }
      if(viewport.width<600){
        await page.waitForFunction(()=>{
          const popup=document.querySelector('.leaflet-popup')?.getBoundingClientRect();
          const controls=document.getElementById('controls').getBoundingClientRect();
          return popup && popup.top>=controls.bottom+60 && popup.bottom<=innerHeight-10;
        });
      }
      assert.equal(await page.evaluate(()=>arrivalsByStop.get(_openStopMarker._stopKey).length),2);
      assert.equal(await page.locator('[data-count="train"]').textContent(),'0');
      await page.evaluate(()=>map.panBy([10,0],{animate:false}));
      await page.waitForFunction(()=>_openStopMarker?.isPopupOpen());
      await page.evaluate(()=>renderStopsForViewport());
      assert.equal(await page.locator('.leaflet-popup-content').count(),1);
      const styles=await page.evaluate(()=>railLinesLayer.getLayers().map(layer=>({code:layer.feature.properties.ROUTENUMBER,weight:layer.options.weight,dash:layer.options.dashArray})));
      assert.ok(styles.find(s=>s.code==='S-C').weight>styles.find(s=>s.code==='E-W').weight);
      assert.equal(styles.find(s=>s.code==='E-W').dash,'10 6');
      fs.mkdirSync(path.join(root,'.test-artifacts'),{recursive:true});
      await page.screenshot({path:path.join(root,'.test-artifacts',`rail-${viewport.width}.png`)});
      const timetableCalls=requests.filter(u=>u.includes('/api/departures')).length;
      await page.evaluate(()=>{const marker=_openStopMarker;map.closePopup();marker.openPopup();});
      assert.equal(requests.filter(u=>u.includes('/api/departures')).length,timetableCalls,'Reopening a fresh timetable uses cached results');
      await page.evaluate(()=>{map.closePopup();map.setView([-36.8485,174.7633],12,{animate:false});});
      if(viewport.width<600) await page.locator('#controls-toggle').click();
      await page.locator('input[data-layer="overlays"]').uncheck();
      await page.locator('.search-icon-btn').click();
      const stationSearch=page.getByRole('textbox',{name:'Search routes, vehicles or stations'});
      await stationSearch.fill('Te Waihorotiu');
      await page.locator('.suggestion-item[data-kind="station"]').first().waitFor();
      await stationSearch.press('Enter');
      await page.locator('.leaflet-popup-content').waitFor();
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Te Waihorotiu/);
      assert.equal(await page.locator('input[data-layer="overlays"]').isChecked(),true);
      await page.evaluate(()=>map.closePopup());
      // Major bus hubs are visible at regional zoom and expose every bay in the timetable.
      await page.evaluate(()=>{const station=findStations('Manukau Bus Station')[0];map.setView([station[0],station[1]],12,{animate:false});renderStopsForViewport();});
      const busStation=page.locator('.bus-station-icon[title="Manukau Bus Station"]');
      await busStation.waitFor();
      await busStation.click();
      await page.waitForFunction(()=>_openStopMarker?._stopType===3 && departuresByStation.get(_openStopMarker._stopKey)?.complete===true);
      const busBoard=await page.locator('.leaflet-popup-content').textContent();
      assert.match(busBoard,/Bus station \/ interchange/);
      assert.match(busBoard,/70/);
      assert.match(busBoard,/Botany/);
      assert.match(busBoard,/Scheduled · Bay/);
      assert.equal(await page.evaluate(()=>departuresByStation.get(_openStopMarker._stopKey).data.length),11);
      await page.locator('.station-details summary').click();
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Bay 18/);
      await page.locator('.station-details summary').click();
      await page.waitForFunction(()=>{
        const popup=document.querySelector('.leaflet-popup')?.getBoundingClientRect();
        return popup && popup.top>=10 && popup.bottom<=innerHeight-10;
      },null,{timeout:5000});
      await page.screenshot({path:path.join(root,'.test-artifacts',`bus-station-${viewport.width}.png`)});
      // An ordinary roadside bus stop gets the same board without querying nearby stops.
      const beforeRoadCalls=requests.filter(u=>u.includes('/api/departures')).length;
      await page.evaluate(()=>{
        map.closePopup();const stop=stopsBus[0];map.setView([stop[0],stop[1]],17,{animate:false});
        renderStopsForViewport();stopMarkersByKey.get(stop[5]).openPopup();
      });
      await page.waitForFunction(()=>_openStopMarker?._stopType===0 && departuresByStation.get(_openStopMarker._stopKey)?.complete===true);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Next services/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Average delay unavailable/);
      assert.match(await page.locator('.leaflet-popup-content').textContent(),/Botany/);
      assert.equal(requests.filter(u=>u.includes('/api/departures')).length,beforeRoadCalls+1);
      await page.screenshot({path:path.join(root,'.test-artifacts',`road-stop-${viewport.width}.png`)});
      await page.evaluate(()=>{map.closePopup();map.setView([-36.8485,174.7633],12,{animate:false});});
      if(viewport.width<600) await page.locator('#controls-toggle').click();
      await page.locator('.search-icon-btn').click();
      await page.getByRole('textbox', { name: 'Search routes, vehicles or stations' }).fill('70');
      await page.locator('.suggestion-item').first().waitFor();
      const search = await page.locator('.search-control').boundingBox();
      assert.ok(search.x + search.width <= viewport.width && search.y + search.height <= viewport.height);
      const suggestions = await page.locator('.search-suggestions').boundingBox();
      assert.ok(suggestions.y + suggestions.height <= viewport.height);
      fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
      await page.screenshot({ path: path.join(root, '.test-artifacts', `search-${viewport.width}.png`) });
      await page.locator('.search-cancel').click();
      await context.setOffline(true);
      await page.locator('#live-status[data-state="offline"]').waitFor();
      assert.equal(await page.locator('#refresh-vehicles').isDisabled(), true);
      await context.setOffline(false);
      await page.locator('#live-status[data-state="live"]').waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('#live-status[data-state="live"]').waitFor();
      assert.equal(await page.locator('input[data-layer="ferry"]').isChecked(), false);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const controls = await page.locator('#controls').boundingBox();
      assert.ok(controls.x >= 0 && controls.x + controls.width <= viewport.width);
      fs.mkdirSync(path.join(root, '.test-artifacts'), { recursive: true });
      await page.screenshot({ path: path.join(root, '.test-artifacts', `ui-${viewport.width}.png`) });
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: rail styles, station clicks and persistent popups, live status, filters, search, offline recovery, lazy loading, refresh, no overflow or JS errors`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
