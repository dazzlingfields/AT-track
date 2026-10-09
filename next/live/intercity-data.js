// Manually maintained from the operators' published timetables, checked 9 Oct 2026.
(function(root){
  const S=typeof module==='object'&&module.exports?require('./schedule-data.js'):root.ScheduleData;
  const checked='2026-10-09',validFrom='2026-09-13';
  const sources={huia:'https://www.tehuiatrain.co.nz/assets/Te-Huia/TeHuiaBooklet.pdf',
    huiaClosures:'https://www.tehuiatrain.co.nz/timetables/',
    explorer:'https://www.greatjourneysnz.com/scenic-trains/northern-explorer-train/timetable/'};
  const names=['Frankton','Rotokauri','Huntly','Pukekohe','Puhinui','Strand'];
  // Stop order: Frankton, Rotokauri, Huntly, Pukekohe, Puhinui, Strand.
  const runs=[
    [[1,2,3,4,5],'north','06:05 06:13 06:36 07:25 07:59 08:35'],
    [[1,2,3,4,5],'north','14:05 14:13 14:36 15:25 15:59 16:35'],
    [[4,5],'north','09:35 09:43 10:06 10:55 11:29 12:00'],
    [[6],'north','07:35 07:43 08:06 08:55 09:29 10:00'],
    [[6],'north','09:05 09:13 09:36 10:25 10:59 11:30'],
    [[0],'north','14:35 14:43 15:06 15:55 16:29 17:05'],
    [[1,2,3,4,5],'south','12:10 12:00 11:33 10:45 10:08 09:40'],
    [[1,2,3,4,5,6],'south','20:10 20:00 19:33 18:45 18:08 17:40'],
    [[4,5],'south','18:10 18:00 17:33 16:45 16:08 15:40'],
    [[6],'south','17:40 17:30 17:03 16:15 15:38 15:10'],
    [[0],'south','20:40 20:30 20:03 19:15 18:38 18:10']
  ];
  // Actual and observed public holidays plus operator-published maintenance closures.
  const holidays=new Set(['2026-10-26','2027-02-01','2027-02-06','2027-02-08','2027-03-26','2027-03-29',
    '2027-04-25','2027-04-26','2027-06-07','2027-06-25','2027-10-25','2027-12-25','2027-12-26','2027-12-27','2027-12-28']);
  function station(name){return names.findIndex(n=>new RegExp('\\b'+n+'\\b','i').test(name||''));}
  function closed(operator,date){
    if(operator==='huia')return holidays.has(date)||['2026-11-07','2026-11-08'].includes(date)||date>='2026-12-25'&&date<='2027-01-10';
    return date>='2026-12-25'&&date<='2027-01-11';
  }
  function services(name,now=Date.now()/1000,limit=8){
    const index=station(name);if(index<0)return [];
    const today=S.dateString(S.parts(now)),rows=[];
    for(let offset=0;offset<7;offset++){
      const date=S.shiftDate(today,offset),day=new Date(date+'T12:00:00Z').getUTCDay();
      if(date<validFrom || date>'2027-12-31')continue;
      const add=(operator,time,kind,destination)=>{
        const epoch=S.timeEpoch(time+':00',date);if(epoch===null||epoch<now)return;
        rows.push({operator,name:operator==='huia'?'Te Huia':'Northern Explorer',date,time,epoch,kind,destination});
      };
      if(!closed('huia',date))for(const [days,direction,times] of runs){
        if(!days.includes(day))continue;
        const terminal=direction==='north'?index===5:index===0;
        add('huia',times.split(' ')[index],terminal?'arrival':'departure',
          terminal?(direction==='north'?'From Hamilton Frankton':'From Auckland Strand'):(direction==='north'?'Auckland Strand':'Hamilton Frankton'));
      }
      if(!closed('explorer',date) && [0,5].includes(index)){
        if([1,4,6].includes(day))add('explorer',index===5?'07:40':'10:00','departure','Wellington');
        if([3,5,0].includes(day))add('explorer',index===5?'19:00':'16:45',index===5?'arrival':'departure',index===5?'From Wellington':'Auckland Strand');
      }
    }
    return rows.sort((a,b)=>a.epoch-b.epoch).slice(0,limit);
  }
  const api={checked,validFrom,sources,station,closed,services};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.IntercityData=api;
})(typeof globalThis==='object'?globalThis:window);
