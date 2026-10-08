// Usage: node scripts/condense-rail.cjs <Train_Route.geojson> <Train_Station.geojson>
// WGS84 inputs; simplify in local metres with a maximum 2 m perpendicular error.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const metrePoint = p => [p[0] * 111320 * Math.cos(36.85 * Math.PI / 180), p[1] * 111320];
function segmentDistance(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy || 1)));
  return Math.hypot(p[0]-a[0]-t*dx, p[1]-a[1]-t*dy);
}
function simplify(points, tolerance = 2) {
  const projected = points.map(metrePoint), keep = new Set([0, points.length-1]);
  const stack = [[0, points.length-1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let max = tolerance, split = -1;
    for (let i = start+1; i < end; i++) {
      const d = segmentDistance(projected[i], projected[start], projected[end]);
      if (d > max) { max = d; split = i; }
    }
    if (split !== -1) { keep.add(split); stack.push([start, split], [split, end]); }
  }
  // Six decimals add less than 8 cm rounding error and retain detailed tunnel curves.
  return [...keep].sort((a,b)=>a-b).map(i=>points[i].slice(0,2).map(n=>+n.toFixed(6)));
}
function condenseRoutes(input) {
  const longest = new Map();
  for (const f of input.features) {
    const code = f.properties.ROUTENUMBER;
    if (!longest.has(code) || f.properties.Shape__Length > longest.get(code).properties.Shape__Length) longest.set(code, f);
  }
  const features = [...longest.values()].map(f => ({type:'Feature', properties:{
    ROUTENUMBER:f.properties.ROUTENUMBER, ROUTENAME:f.properties.ROUTENAME,
    ROUTEPATTERN:f.properties.ROUTEPATTERN, AGENCYNAME:f.properties.AGENCYNAME,
    MODE:'Train', Shape__Length:Math.round(f.properties.Shape__Length)
  }, geometry:{type:f.geometry.type, coordinates:f.geometry.type === 'LineString'
    ? simplify(f.geometry.coordinates) : f.geometry.coordinates.map(line=>simplify(line))}}));
  return {type:'FeatureCollection', features};
}
function condenseStations(input) {
  const groups = new Map();
  for (const f of input.features) {
    const p = f.properties, name = p.STOPNAME.replace(/\s+(platform\s*)?\d+$/i,'').trim();
    const key = p.PARENTSTATION || name;
    if (!groups.has(key)) groups.set(key, {name, key, points:[], platforms:[]});
    const group = groups.get(key);
    group.points.push(f.geometry.coordinates);
    group.platforms.push({id:p.STOPID, code:String(p.STOPCODE), name:p.STOPNAME,
      ...(p.STOPDESC ? {description:p.STOPDESC} : {})});
  }
  return {type:'FeatureCollection', features:[...groups.values()].map(g=>({type:'Feature',
    properties:{STOPNAME:g.name, PARENTSTATION:g.key, MODE:'Train', platforms:g.platforms},
    geometry:{type:'Point', coordinates:[0,1].map(i=>+(g.points.reduce((n,p)=>n+p[i],0)/g.points.length).toFixed(6))}
  }))};
}
if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Provide route and station GeoJSON input paths');
  for (const [file, data] of [['train_routes.geojson',condenseRoutes(read(process.argv[2]))],
    ['train_stations.geojson',condenseStations(read(process.argv[3]))]]) {
    const json = JSON.stringify(data);
    fs.writeFileSync(path.join(root,file),json+'\n');
    console.log(`${file}: ${data.features.length} features, ${Buffer.byteLength(json)} bytes`);
  }
}
module.exports = {simplify, metrePoint, segmentDistance, condenseRoutes, condenseStations};
