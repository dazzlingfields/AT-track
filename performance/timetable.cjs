const S=require('../schedule-data.js');
const {timetableIds}=require('./transfers.cjs');
async function requestTimetable({proxy,key,fetcher=fetch,now=Date.now()/1000}){
  const get=async(url,headers={})=>{
    const response=await fetcher(url,{headers,signal:AbortSignal.timeout(10000),cache:'no-store'});
    if(!response.ok)throw Error(`Papakura timetable returned ${response.status}`);
    const payload=await response.json();if(!Array.isArray(payload.data))throw Error('Papakura timetable is missing its data list');return payload;
  };
  if(proxy)return get(`${proxy.replace(/\/$/,'')}/api/departures?ids=${timetableIds.map(encodeURIComponent).join(',')}`);
  if(!key)throw Error('Papakura timetable API is not configured');
  const data=[],errors=[];
  for(const id of timetableIds){
    for(const window of S.windows(now)){
      const url=new URL(`https://api.at.govt.nz/gtfs/v3/stops/${encodeURIComponent(id)}/stoptrips`);
      url.searchParams.set('filter[date]',window.date);url.searchParams.set('filter[start_hour]',window.startHour);url.searchParams.set('filter[hour_range]',window.hourRange);
      try{const payload=await get(url.href,{'Ocp-Apim-Subscription-Key':key});
        for(const candidate of S.candidates(payload,id,window.date)){const row=S.departure(candidate);if(row)data.push(row);else errors.push({error:'Missing scheduled time'});}
        if(payload.links?.next)errors.push({error:'Timetable pagination is incomplete'});
      }catch(error){errors.push({error:error.message});}
    }
  }
  return {data,complete:!errors.length,errors};
}
module.exports={requestTimetable};
