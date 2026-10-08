import Feed from '../feed.cjs';
import Utils from '../http-utils.cjs';
import { CloudStore } from './store.mjs';
import Transfers from '../transfers.cjs';
import Timetable from '../timetable.cjs';
import Positions from '../positions.cjs';
import Occupancy from '../occupancy.cjs';
import Trips from '../trips.cjs';
import CompactFeed from '../compact-feed.cjs';
import WebPolicy from '../web-policy.cjs';
import {allowedOrigin,withCors,preflight,cachedCatalogue} from './pages-api.mjs';
import {collectorClass} from './alarm-collector.mjs';
async function loadTripAsset(env,name){const response=await env.ASSETS.fetch(new Request('https://timetable.internal/timetables/'+encodeURIComponent(name)));return response.ok?response.json():null;}
const {extract,dateAt}=Feed;
const {options,csvCell}=Utils;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function authorized(request,env){
  if(!env.DASHBOARD_PASSWORD)return false;
  const expected='Basic '+btoa('admin:'+env.DASHBOARD_PASSWORD),given=request.headers.get('authorization')||'';
  // Compare fixed length hashes without early character exits.
  const encode=new TextEncoder(),[a,b]=await Promise.all([expected,given].map(v=>crypto.subtle.digest('SHA-256',encode.encode(v))));
  let diff=0;const aa=new Uint8Array(a),bb=new Uint8Array(b);for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];return diff===0;
}
export async function collect(env,now=Date.now()){
  const store=new CloudStore(env.DB),previous=await store.getState('collector')||{};
  if(previous.retryAt>now)return;
  // Atomic lease prevents overlapping cron executions from ingesting concurrently.
  const leaseValue=String(now+55000);
  const lease=await store.run(`INSERT INTO state VALUES('lease',?) ON CONFLICT DO UPDATE SET value=excluded.value WHERE CAST(state.value AS INTEGER) < ?`,leaseValue,now);
  if(!lease.meta.changes)return;
  const configured=Boolean(env.AT_API_KEY||env.AT_PROXY_URL);
  const status={configured,running:true,lastAttempt:new Date(now).toISOString(),lastSuccess:previous.lastSuccess||null,intervalSeconds:env.COLLECTOR?20:60,engine:env.COLLECTOR?'durable-alarm':'cron',error:null};
  try{
    // Persist the attempt before parsing/ingestion so a terminated run cannot look healthy.
    await store.setState('collector',status);
    if(!configured)throw Error('Set the AT_API_KEY secret or AT_PROXY_URL to start collection.');
    const routes=await store.routes();
    let metadata;
    const request=async resource=>{
      const url=env.AT_PROXY_URL?`${env.AT_PROXY_URL.replace(/\/$/,'')}/api/${resource}`:`https://api.at.govt.nz/${resource==='routes'?'gtfs/v3/routes':resource==='realtime'?'realtime/legacy':'realtime/legacy/tripupdates'}`;
      const response=await fetch(url,{headers:env.AT_PROXY_URL?{}:{'Ocp-Apim-Subscription-Key':env.AT_API_KEY},signal:AbortSignal.timeout(10000)});
      if(response.status===429){const ra=response.headers.get('retry-after'),seconds=Number(ra);status.retryAt=now+Math.max(60000,Number.isFinite(seconds)?seconds*1000:(Date.parse(ra)||now+60000)-now);}
      if(!response.ok)throw Error(`Transport API returned ${response.status}`);
      if(response.headers.get('x-cache')?.includes('stale'))throw Error('Transport proxy returned stale data');
      if(resource==='routes')return response.json();
      return CompactFeed.decode(await response.text(),routes,metadata);
    };
    let catalogue=await store.getState('catalogue');
    if(!catalogue||now-catalogue.time>3600000){
      const payload=await request('routes');if(!Array.isArray(payload.data)||!payload.data.length)throw Error('Route catalogue is missing its data list');
      catalogue={time:now,rows:payload.data.map(r=>[String(r.id),r.attributes??r])};await store.setState('catalogue',catalogue);
    }
    metadata=new Map(catalogue.rows);
    let feed,locationError=null;
    try{feed=await request('realtime');}catch(error){if(status.retryAt>now)throw error;locationError=error.message;feed=await request('tripupdates');}
    const batch=extract(feed,routes,metadata,Date.now()/1000);await store.ingest(batch);
    status.lastSuccess=new Date().toISOString();status.lastBatch={events:batch.events.length,cancellations:batch.cancellations.length,ignored:batch.ignored};
    console.log(JSON.stringify({event:'stop_reports_saved',...status.lastBatch}));
    try{status.timetablesArchived=await Trips.sync(store,routes,batch,name=>loadTripAsset(env,name));}catch(error){status.tripTimetableError=error.message;}
    await store.setState('adherence',{lastSuccess:new Date().toISOString(),services:batch.adherence.map(s=>({...s,stopName:s.stopId?Transfers.stopName(s.stopId):''}))});
    const location={lastAttempt:new Date(now).toISOString(),lastSuccess:null,error:locationError,vehicles:[],station:Positions.station};
    if(!locationError){try{location.vehicles=Positions.extract(feed,routes,new Map(catalogue.rows));await store.savePositions(location.vehicles);await store.saveOccupancy(Occupancy.extract(feed,routes,new Map(catalogue.rows)));location.lastSuccess=new Date().toISOString();}catch(error){location.error=error.message;}}
    await store.setState('positions',location);
    const previousTimetable=await store.getState('timetable');
    if(!previousTimetable||previousTimetable.stopIds?.join(',')!==Transfers.timetableIds.join(',')||now-Date.parse(previousTimetable.lastAttempt)>300000){
      const info={lastAttempt:new Date(now).toISOString(),lastSuccess:previousTimetable?.lastSuccess||null,error:null,complete:false,stopIds:Transfers.timetableIds};
      try{
        const payload=await Timetable.requestTimetable({proxy:env.AT_PROXY_URL,key:env.AT_API_KEY});
        await store.saveSchedules(Transfers.scheduleRows(payload,routes));info.lastSuccess=new Date().toISOString();info.complete=payload.complete!==false;
        if(!info.complete)info.error='Papakura timetable is partial; captured services are retained';
      }catch(error){info.error=error.message;}
      await store.setState('timetable',info);
    }
    console.log(JSON.stringify({event:'collection_complete',...status.lastBatch}));
  }catch(error){status.error=error.message;console.error(JSON.stringify({event:'collection_failed',message:error.message}));}
  finally{
    status.running=false;
    // Keep the lease row: updating its unindexed value avoids deleting/rebuilding
    // the primary-key index twice per poll. Only its owner may release it.
    try{await store.setState('collector',status);}
    finally{await store.run("UPDATE state SET value='0' WHERE key='lease' AND value=?",leaseValue);}
    console.log(JSON.stringify({event:'d1_collection_usage',rowsWritten:store.rowsWritten,intervalSeconds:status.intervalSeconds}));
  }
  return status;
}
export async function collectScheduled(env,{sample=collect,cleanup=now=>new CloudStore(env.DB).purgeHistory(now),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),clock=Date.now,offsets=[0]}={}){
  const start=clock();
  try{await cleanup(start);}catch(error){console.error(JSON.stringify({event:'retention_failed',message:error.message}));}
  for(const offset of offsets){
    const remaining=start+offset-clock();if(remaining>0)await sleep(remaining);
    // Do not catch up missed polls in a burst or spill into the next cron minute.
    if(clock()-start>=55000)break;
    if(offset&&clock()-start>offset+5000)continue;
    const status=await sample(env,clock());if(!status||status.error||status.retryAt>clock())break;
  }
}
const handler={
  async scheduled(controller,env,ctx){ctx.waitUntil(env.COLLECTOR?env.COLLECTOR.get(env.COLLECTOR.idFromName('performance')).fetch('https://collector.internal/start'):collectScheduled(env));},
  async fetch(request,env){
    if(!env.DASHBOARD_PASSWORD)return new Response('Setup required: set the DASHBOARD_PASSWORD secret before opening the dashboard.',{status:503});
    if(!await authorized(request,env))return new Response('Sign in with username admin and your dashboard password.',{status:401,headers:{'WWW-Authenticate':'Basic realm="AT route performance", charset="UTF-8"','Cache-Control':'no-store'}});
    const url=new URL(request.url),store=new CloudStore(env.DB);
    try{
      if(['POST','PATCH'].includes(request.method)){
        if(request.headers.get('origin')&&request.headers.get('origin')!==url.origin&&!allowedOrigin(request,env))return json({error:'Cross-origin writes are blocked'},403);
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Use application/json'},415);
        if(Number(request.headers.get('content-length'))>8192)return json({error:'Request body too large'},413);
      }
      const body=async()=>{const text=await request.text();if(text.length>8192)throw Error('Request body too large');return JSON.parse(text);};
      if(request.method==='GET'&&url.pathname==='/api/status')return json({...await store.getState('collector'),retention:await store.getState('retention'),configured:Boolean(env.AT_API_KEY||env.AT_PROXY_URL),today:dateAt(Date.now()/1000),intervalSeconds:env.COLLECTOR?20:60,reportRefreshSeconds:60});
      if(request.method==='GET'&&url.pathname==='/api/routes')return json(await store.routes());
      if(request.method==='GET'&&['/api/trips','/api/trip'].includes(url.pathname))return json(await Trips.view(store,Trips.options(url),name=>loadTripAsset(env,name)));
      if(request.method==='POST'&&url.pathname==='/api/collect'){
        const status=await store.getState('collector');
        if(status?.lastAttempt&&Date.now()-Date.parse(status.lastAttempt)<60000)return json({error:'Collection already attempted in the last minute'},429);
        if(env.COLLECTOR){await env.COLLECTOR.get(env.COLLECTOR.idFromName('performance')).fetch('https://collector.internal/start');return json({scheduled:true});}
        await collect(env);return json(await store.getState('collector'));
      }
      if(request.method==='POST'&&url.pathname==='/api/routes'){await store.addRoute(await body());return json(await store.routes(),201);}
      if(request.method==='PATCH'&&/^\/api\/routes\/\d+$/.test(url.pathname)){
        const data=await body();if(typeof data.active!=='boolean')throw Error('active must be true or false');
        const result=await store.toggle(Number(url.pathname.split('/').pop()),data.active);return result.meta.changes?json(await store.routes()):json({error:'Route not found'},404);
      }
      if(request.method==='GET'&&url.pathname==='/api/report')return json(await store.report(options(url)));
      if(request.method==='GET'&&url.pathname==='/api/transfers')return json(await store.transfers({...options(url),...Transfers.transferOptions(url)}));
      if(request.method==='GET'&&url.pathname==='/api/occupancy')return json(await store.occupancy(options(url)));
      if(request.method==='GET'&&url.pathname==='/api/export'){
        const rows=await store.exportRows(options(url));if(rows.length>10000)return json({error:'Cloud exports are limited to 10,000 events. Select a shorter date range or one route.'},400);
        const names=new Map((await store.routes()).map(r=>[r.id,r.code])),columns=['route','trip_id','service_date','start_time','stop_id','sequence','kind','event_time','scheduled_time','delay_sec','reported_at'];
        const csv=[columns.join(','),...rows.map(r=>columns.map(c=>csvCell(c==='route'?names.get(r.route_id):r[c])).join(','))].join('\r\n');
        return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="route-performance.csv"','Cache-Control':'no-store'}});
      }
      if(url.pathname.startsWith('/api/'))return json({error:'Not found'},404);
      const response=await env.ASSETS.fetch(request), secured=new Response(response.body,response);
      secured.headers.set('Cache-Control','private, no-store');secured.headers.set('X-Content-Type-Options','nosniff');
      secured.headers.set('Content-Security-Policy',WebPolicy.contentSecurityPolicy(url.pathname));return secured;
    }catch(error){return json({error:error.message},400);}
  }
};
export default {
 scheduled:handler.scheduled,
 async fetch(request,env,ctx){
  const url=new URL(request.url),origin=allowedOrigin(request,env);
  if(url.pathname.startsWith('/api/')&&request.method==='OPTIONS')return preflight(request,env);
  if(url.pathname==='/api/network/routes'){
   if(request.method!=='GET')return withCors(json({error:'Method not allowed'},405),origin);
   try{return withCors(await cachedCatalogue(request,env,ctx),origin);}catch{return withCors(json({error:'Route cache unavailable'},503),origin);}
  }
  return withCors(await handler.fetch(request,env),url.pathname.startsWith('/api/')?origin:null);
 }
};
export const PerformanceCollector=collectorClass(collect,(env,now)=>new CloudStore(env.DB).purgeHistory(now));
