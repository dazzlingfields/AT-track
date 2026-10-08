// Compile AT's official static feed into one small asset per route.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
function csv(line){const fields=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){fields.push(value);value='';}else value+=c;}if(quoted)throw Error('Unclosed CSV field');fields.push(value);return fields;}
async function* records(file){let header;for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){if(!line)continue;const fields=csv(line);if(!header){header=fields;continue;}yield Object.fromEntries(header.map((key,i)=>[key,fields[i]??'']));}}
const seconds=text=>/^\d{1,2}:[0-5]\d:[0-5]\d$/.test(text)?text.split(':').reduce((n,v)=>n*60+Number(v),0):null;
async function build(input,output){
 const read=name=>records(path.join(input,name+'.txt')),routes=new Map(),trips=new Map(),stops={},calendar=[],exceptions=[];let feed;
 for await(const r of read('feed_info'))feed=r;
 for await(const r of read('calendar'))calendar.push(r);
 for await(const r of read('calendar_dates'))exceptions.push(r);
 for await(const r of read('stops'))stops[r.stop_id]=r.stop_name;
 for await(const r of read('routes'))routes.set(r.route_id,{code:r.route_short_name,mode:Number(r.route_type),trips:[]});
 for await(const r of read('trips')){const route=routes.get(r.route_id);if(!route||![2,3].includes(route.mode))continue;const trip={id:r.trip_id,service:r.service_id,destination:r.trip_headsign,direction:Number(r.direction_id),stops:[]};route.trips.push(trip);trips.set(r.trip_id,trip);}
 for await(const r of read('stop_times')){const trip=trips.get(r.trip_id);if(trip)trip.stops.push([Number(r.stop_sequence),r.stop_id,seconds(r.arrival_time),seconds(r.departure_time),Number(r.pickup_type),Number(r.drop_off_type)]);}
 fs.mkdirSync(output,{recursive:true});const grouped=new Map();for(const route of routes.values()){if(!route.trips.length)continue;const key=route.mode+'-'+route.code;if(!/^[\dA-Za-z_-]+$/.test(key))throw Error('Invalid route asset name');if(!grouped.has(key))grouped.set(key,{...route,trips:[]});grouped.get(key).trips.push(...route.trips);}
 for(const [key,route] of grouped){const ids=new Set(route.trips.map(t=>t.service)),names={};for(const t of route.trips){t.stops.sort((a,b)=>a[0]-b[0]);for(const s of t.stops)names[s[1]]=stops[s[1]]||s[1];}fs.writeFileSync(path.join(output,key+'.json'),JSON.stringify({generatedAt:new Date().toISOString(),source:'https://gtfs.at.govt.nz/gtfs.zip',feed,calendar:calendar.filter(c=>ids.has(c.service_id)),exceptions:exceptions.filter(c=>ids.has(c.service_id)),stops:names,...route}));}
 console.log(`Built ${grouped.size} route timetable assets (${trips.size} trips).`);
}
if(require.main===module)build(process.argv[2]||'.test-artifacts/gtfs',process.argv[3]||'performance/public/timetables').catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={csv,seconds,build};
