const Feed=require('./feed.cjs');
// The AT proxy serializes each entity with its id first. Locate relevant route
// descriptors natively, then decode only their enclosing entities. Other JSON
// layouts use the ordinary parser, preserving compatibility and correctness.
function decode(text,routes,metadata){
 const header=text.match(/"header"\s*:\s*(\{[^{}]*\})/);
 if(!header||!text.includes('"entity":[')||!/^\s*\{/.test(text)||!text.trimEnd().endsWith('}'))return JSON.parse(text);
 const matches=new Map(),selected=new Map(),pattern=/"route_id"\s*:\s*"([^"\\]*)"/g;let match;
 while((match=pattern.exec(text))){const id=match[1];if(!matches.has(id))matches.set(id,routes.some(r=>r.active&&Feed.matches(r,{route_id:id},metadata.get(id))));if(!matches.get(id))continue;
  const start=text.lastIndexOf('{"id":',match.index);if(start<0)return JSON.parse(text);if(selected.has(start))continue;
  let depth=0,quoted=false,escaped=false,end=-1;
  for(let i=start;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}}
  if(end<0)return JSON.parse(text);const entity=JSON.parse(text.slice(start,end)),trip=(entity.trip_update??entity.tripUpdate)?.trip??entity.vehicle?.trip;
  if(trip?.route_id!==id)return JSON.parse(text);selected.set(start,entity);
 }
 return {header:JSON.parse(header[1]),entity:[...selected.values()]};
}
module.exports={decode};
