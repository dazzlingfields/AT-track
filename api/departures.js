// Station timetable proxy. The existing AT_API_KEY stays on the server.
import ScheduleData from '../schedule-data.js';

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Expose-Headers','Retry-After, x-cache');
  if(req.method==='OPTIONS') return res.status(204).end();
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET') return res.status(405).json({error:'Use GET'});
  const ids=[...new Set(String(req.query.ids||'').split(',').map(s=>s.trim()).filter(Boolean))];
  if(!ids.length || ids.length>8 || ids.some(id=>! /^[a-z\d_.-]{1,100}$/i.test(id))){
    return res.status(400).json({error:'Provide 1–8 platform stop IDs'});
  }
  if(!process.env.AT_API_KEY) return res.status(503).json({error:'Timetable API is not configured'});

  globalThis.__AT_DEPARTURES_CACHE__ ||= new Map();
  globalThis.__AT_DEPARTURES_PENDING__ ||= new Map();
  const cache=globalThis.__AT_DEPARTURES_CACHE__,pending=globalThis.__AT_DEPARTURES_PENDING__;
  const now=Date.now()/1000,windows=ScheduleData.windows(now);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  const errors=[],invalidTimes=[],candidates=[],departures=[];
  let requests=0,retryAfter=null;
  const apiOrigin='https://api.at.govt.nz';

  async function resource(initial,ttl){
    const key=initial.href,old=cache.get(key);
    if(old && Date.now()-old.time<ttl) return old.data;
    if(pending.has(key)) return pending.get(key);
    const work=(async()=>{
      const records=[],included=[],visited=new Set();let url=initial;
      while(url){
        if(controller.signal.aborted) throw Error('Timetable request timed out');
        if(visited.has(url.href) || visited.size>=8) throw Error('Timetable pagination limit exceeded');
        if(url.origin!==apiOrigin || url.pathname!==initial.pathname) throw Error('Unexpected timetable pagination URL');
        if(++requests>40) throw Error('Timetable request budget exceeded');
        visited.add(url.href);
        const response=await fetch(url.href,{headers:{'Ocp-Apim-Subscription-Key':process.env.AT_API_KEY},
          cache:'no-store',signal:controller.signal});
        const body=await response.text(); // abort covers the response body, not just headers
        if(!response.ok){
          const error=Error(`Timetable upstream returned ${response.status}`);
          error.status=response.status;error.retryAfter=response.headers.get('retry-after')||'30';throw error;
        }
        const payload=JSON.parse(body);
        if(!Array.isArray(payload.data)) throw Error('Timetable response is missing its data list');
        records.push(...payload.data);
        if(Array.isArray(payload.included)) included.push(...payload.included);
        const next=payload.links?.next?.href??payload.links?.next;
        url=typeof next==='string' && next?new URL(next,url):null;
      }
      const data={data:records,included};
      cache.set(key,{time:Date.now(),data});
      while(cache.size>2000) cache.delete(cache.keys().next().value);
      return data;
    })().finally(()=>pending.delete(key));
    pending.set(key,work);return work;
  }
  async function pool(jobs,run){
    let index=0;
    await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{
      while(index<jobs.length && !controller.signal.aborted && !retryAfter){
        const job=jobs[index++];
        try{await run(job);}catch(error){
          errors.push({stopId:job.stopId||job.candidate?.stopId||'',error:error.message});
          if(error.status===429) retryAfter=error.retryAfter;
        }
      }
    }));
    for(const job of jobs.slice(index)) errors.push({stopId:job.stopId||job.candidate?.stopId||'',error:retryAfter?'Rate limited':'Timetable request timed out'});
  }
  try{
    await pool(ids.flatMap(stopId=>windows.map(window=>({stopId,window}))),async({stopId,window})=>{
      const url=new URL(`/gtfs/v3/stops/${encodeURIComponent(stopId)}/stoptrips`,apiOrigin);
      url.searchParams.set('filter[date]',window.date);
      url.searchParams.set('filter[start_hour]',String(window.startHour));
      url.searchParams.set('filter[hour_range]',String(window.hourRange));
      const data=await resource(url,120000);
      // Nonempty but unrecognisable rows must not be mistaken for a station with no trains.
      const rows=ScheduleData.candidates(data,stopId,window.date);
      if(data.data.length && !rows.length) throw Error('Timetable rows could not be matched to this platform');
      candidates.push(...rows);
    });
    const missing=new Map(),usable=new Set();
    for(const candidate of candidates){
      if(Number(candidate.pickupType)===1) continue;
      const row=ScheduleData.departure(candidate),key=`${candidate.tripId}|${candidate.serviceDate}|${candidate.stopId}`;
      if(row){departures.push(row);usable.add(key);}
      else if(!missing.has(key)) missing.set(key,{candidate});
    }
    const fallback=[...missing].filter(([key])=>!usable.has(key)).map(([,job])=>job);
    // Most stoptrips rows already contain clock times; bound fallback calls for bad data.
    await pool(fallback.slice(0,8),async({candidate})=>{
      const url=new URL(`/gtfs/v3/trips/${encodeURIComponent(candidate.tripId)}/stoptimes`,apiOrigin);
      const data=await resource(url,6*3600000);
      const rows=ScheduleData.candidates(data,candidate.stopId,candidate.serviceDate)
        .filter(c=>c.tripId===candidate.tripId && (candidate.sequence==null || c.sequence==null || Number(candidate.sequence)===Number(c.sequence)));
      let found=false;
      for(const row of rows){
        const entry=ScheduleData.departure({...candidate,...row,routeId:row.routeId||candidate.routeId,destination:row.destination||candidate.destination});
        if(entry){departures.push(entry);found=true;}
      }
      if(!found) invalidTimes.push({stopId:candidate.stopId,tripId:candidate.tripId});
    });
    if(fallback.length>8) errors.push({error:'Some timetable rows require additional stop-time lookups'});
    const unique=new Map();
    for(const row of departures){
      if(row.scheduledTime<now-3600 || row.scheduledTime>now+7200) continue;
      const key=`${row.tripId}|${row.serviceDate}|${row.sequence??row.scheduledTime}`;
      if(!unique.has(key)) unique.set(key,row);
    }
    const data=[...unique.values()].sort((a,b)=>a.scheduledTime-b.scheduledTime);
    const complete=!errors.length && !invalidTimes.length;
    if(retryAfter) res.setHeader('Retry-After',retryAfter);
    if(complete) res.setHeader('Cache-Control','public, max-age=0, s-maxage=15');
    return res.status(retryAfter && !data.length?429:errors.length && !data.length?502:200).json({data,
      generatedAt:Math.floor(now),timezone:ScheduleData.zone,complete,errors,
      invalidTimeCount:invalidTimes.length,...(retryAfter?{retryAfter}: {})});
  }finally{clearTimeout(timer);}
}
