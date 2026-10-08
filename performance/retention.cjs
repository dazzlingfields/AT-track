const {dateAt}=require('./feed.cjs');
// Retain complete Auckland service days from three calendar months ago.
// Clamp month ends (31 May -> 28/29 February) rather than overflowing into March.
function policy(now=Date.now()){
  const today=dateAt(now/1000),[year,month,day]=today.split('-').map(Number);
  const target=new Date(Date.UTC(year,month-1-3,1));
  const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,lastDay));
  return {months:3,today,cutoff:target.toISOString().slice(0,10),lastSuccess:new Date(now).toISOString()};
}
const tables=['events','cancellations','station_schedules','station_positions','occupancy_samples','station_predictions','trip_timetables'];
module.exports={policy,tables};
