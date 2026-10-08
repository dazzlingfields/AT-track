const S=require('../schedule-data.js');
const names=require('./stop-names.json');
const fold=s=>String(s??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const minute=value=>value?Number(value.slice(0,2))*60+Number(value.slice(3)):null;
function searchOptions(q){
  const search=String(q.get('q')||'').trim(),timeFrom=q.get('timeFrom')||'',timeTo=q.get('timeTo')||'',page=Number(q.get('page')||1);
  if(search.length>80||[timeFrom,timeTo].some(t=>t&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))||!Number.isInteger(page)||page<1||page>1000000)throw Error('Enter valid search text, HH:MM times and page number');
  return {search,timeFrom,timeTo,page};
}
function clockMatch(epoch,from,to){
  if(!from&&!to)return true;if(epoch==null)return false;
  const p=S.parts(epoch),m=p.hour*60+p.minute,lo=minute(from),hi=minute(to);
  return lo!==null&&hi!==null&&lo>hi?m>=lo||m<=hi:(lo===null||m>=lo)&&(hi===null||m<=hi);
}
function filterEvents(rows,routes,{search='',timeFrom='',timeTo=''}){
  const term=fold(search),routeNames=new Map(routes.map(r=>[r.id,`${r.code} ${r.name}`]));
  return rows.filter(e=>clockMatch(e.event_time,timeFrom,timeTo)&&(!term||fold(`${routeNames.get(e.route_id)||''} ${e.trip_id} ${e.start_time} ${e.stop_id} ${names[String(e.stop_id).split('-')[0]]||''}`).includes(term)));
}
function offsets(from,to){
  const start=S.localEpoch(from,0)-86400,end=S.localEpoch(to,0)+4*86400,rows=[];
  const offset=t=>{const p=S.parts(t);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)/1000-t;};
  let cursor=start,current=offset(start),segment=start;
  while(cursor<end){const next=Math.min(end,cursor+7*86400),nextOffset=offset(next-1);
    if(nextOffset!==current){let low=cursor,high=next-1;while(high-low>1){const mid=Math.floor((low+high)/2);if(offset(mid)===current)low=mid;else high=mid;}
      rows.push({start:segment,end:high,offset:current});segment=high;current=nextOffset;
    }cursor=next;
  }
  rows.push({start:segment,end,offset:current});return rows;
}
function eventSql(filters){
  const {from,to,routeId=0,kind='arrival',search='',timeFrom='',timeTo=''}=filters;
  let where='service_date BETWEEN ? AND ? AND (?=0 OR route_id=?) AND kind=?',params=[from,to,routeId,routeId,kind];
  if(search){const term=fold(search),codes=Object.keys(names).filter(code=>fold(names[code]).includes(term)||code.includes(term));
    where+=` AND (instr(lower(trip_id),?)>0 OR instr(lower(start_time),?)>0 OR instr(lower(stop_id),?)>0
      OR route_id IN(SELECT id FROM routes WHERE instr(lower(code || ' ' || name),?)>0)
      OR (CASE WHEN instr(stop_id,'-')>0 THEN substr(stop_id,1,instr(stop_id,'-')-1) ELSE stop_id END) IN(SELECT value FROM json_each(?)))`;
    params.push(term,term,term,term,JSON.stringify(codes));
  }
  if(timeFrom||timeTo){
    const m="(CAST((event_time+json_extract(value,'$.offset'))/60 AS INTEGER)%1440)",lo=minute(timeFrom),hi=minute(timeTo);
    let clock;if(lo!==null&&hi!==null&&lo>hi){clock=`(${m}>=? OR ${m}<=?)`;}else clock=`(${lo!==null?m+'>=?':'1'} AND ${hi!==null?m+'<=?':'1'})`;
    where+=` AND EXISTS(SELECT 1 FROM json_each(?) WHERE event_time>=json_extract(value,'$.start') AND event_time<json_extract(value,'$.end') AND ${clock})`;
    params.push(JSON.stringify(offsets(from,to)));if(lo!==null)params.push(lo);if(hi!==null)params.push(hi);
  }
  return {where,params};
}
function dailyExtremes(rows){
  const result=[];
  for(const date of [...new Set(rows.filter(e=>e.delay_sec!==null&&e.delay_sec!==0).map(e=>e.service_date))].sort().reverse()){
    const day=rows.filter(e=>e.service_date===date&&e.delay_sec!==null),rank=(sign)=>{
      const seen=new Set();return day.filter(e=>sign===1?e.delay_sec>0:e.delay_sec<0).sort((a,b)=>sign*(b.delay_sec-a.delay_sec)||b.event_time-a.event_time).filter(e=>{
        const key=JSON.stringify([e.route_id,e.trip_id,e.start_time]);if(seen.has(key))return false;seen.add(key);return true;
      }).slice(0,5);
    };result.push({date,late:rank(1),early:rank(-1)});
  }return result;
}
module.exports={searchOptions,clockMatch,filterEvents,eventSql,dailyExtremes,fold,offsets};
