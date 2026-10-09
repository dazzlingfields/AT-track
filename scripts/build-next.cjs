// Build the combined workspace from the maintained map and performance apps.
// No keys, database copies, or changes to the original frontends.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const source=path.join(root,'performance/next');
const target=path.join(root,'performance/public/next');
const read=file=>fs.readFileSync(file,'utf8');
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
function replace(text,from,to){if(!text.includes(from))throw Error('Workspace build anchor missing: '+from.slice(0,80));return text.replace(from,to);}
let original=read(path.join(root,'performance/public/index.html'));
let content=original.match(/<main>([\s\S]*?)<\/main>/)[1];
content=content.replace(/<div class="intro">[\s\S]*?<\/div>\s*<div id="notice"/, '<div id="notice"');
content=content.replace(/<nav class="page-nav"[\s\S]*?<\/nav>/,'');
content=content.replace('class="settings panel" data-views="overview"','class="settings panel" data-views="overview settings"');
const dialog=original.match(/<dialog[\s\S]*?<\/dialog>/)[0];
write(path.join(target,'index.html'),read(path.join(source,'shell.html')).replace('{{CONTENT}}',content).replace('{{DIALOG}}',dialog));
let app=read(path.join(root,'performance/public/app.js'));
app=replace(app,'const response=await fetch(path,options);','const response=await window.ATBackend.fetch(path,options);');
app=replace(app,'async function refresh(force=false){',"async function refresh(force=false){\n  if(window.ATBackend.remote&&!window.ATBackend.connected){$('#connection').textContent='Performance sign-in needed';return;}");
app=replace(app,"document.querySelectorAll('[data-view],[data-open-view]')","document.querySelectorAll('button[data-view],button[data-open-view]')");
app=replace(app,"'trips','route'].includes(next)?next:'overview'","'trips','route','live','service','settings'].includes(next)?next:'live'");
app=replace(app,"$('#filters').hidden=currentView==='trips';$('.section-links').hidden=currentView==='trips';$('#selection-summary').hidden=currentView==='trips';", "$('#filters').hidden=['trips','live','service','settings'].includes(currentView);$('.section-links').hidden=['trips','live','service','settings'].includes(currentView);$('#selection-summary').hidden=['trips','live','service','settings'].includes(currentView);");
app=replace(app,"  window.scrollTo({top:0,behavior:'auto'});", "  document.dispatchEvent(new CustomEvent('workspace:view',{detail:currentView}));\n  window.scrollTo({top:0,behavior:'auto'});");
app=replace(app,"  $('#export').href='/api/export?'+query();", "  $('#export').href='/api/export?'+query();\n  document.dispatchEvent(new CustomEvent('workspace:report',{detail:report}));");
app=replace(app,"    todayDate=status.today;", "    document.dispatchEvent(new CustomEvent('workspace:status',{detail:status}));\n    todayDate=status.today;");
app+=`\nwindow.ATWorkspace={setView,openRoute,openTrip,refresh,getRoutes:()=>routes,getToday:()=>todayDate,track:async data=>{await api('/api/routes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});await refresh(true);}};\n`;
write(path.join(target,'app.js'),app);
for(const file of ['style.css','workspace.js','backend.js','manifest.webmanifest'])fs.copyFileSync(path.join(source,file),path.join(target,file));
write(path.join(target,'config.js'),'window.AT_TRACK_CONFIG={};\n');
fs.copyFileSync(path.join(root,'performance/public/style.css'),path.join(target,'performance.css'));
let mapHtml=read(path.join(root,'index.html'));
mapHtml=replace(mapHtml,'</head>','<link rel="stylesheet" href="map.css"></head>');
mapHtml=replace(mapHtml,'<script defer src="script.js"></script>','<script defer src="script.js"></script><script defer src="bridge.js"></script>');
mapHtml=mapHtml.replace('>AT Track</span>','>Map options</span>');
write(path.join(target,'live/index.html'),mapHtml);
let mapScript=read(path.join(root,'script.js'));
// Embedded map delegates offline state to the existing snapshot code. Never
// register an extra service worker that could intercept authenticated reports.
mapScript=replace(mapScript,'if("serviceWorker" in navigator){','if(false && "serviceWorker" in navigator){');
mapScript=replace(mapScript,'function isPageVisible(){ return document.visibilityState !== "hidden"; }','function isPageVisible(){ return document.visibilityState !== "hidden" && window.atWorkspaceVisible!==false; }');
mapScript=replace(mapScript,'  return base', '  return base + \'<br><button type="button" class="workspace-service-link">View service details →</button>\'');
mapScript=replace(mapScript,'currentType:typeKey,vehicleLabel,licensePlate,busType,speedStr,scheduleLine,nextStopLine,occupancy,bikesLine,routeName,destination,extraLines,badgeText,bearingDeg:', 'currentType:typeKey,delaySec,serviceDate:v.vehicle?.trip?.start_date,tripStart,vehicleLabel,licensePlate,busType,speedStr,scheduleLine,nextStopLine,occupancy,bikesLine,routeName,destination,extraLines,badgeText,bearingDeg:');
write(path.join(target,'live/script.js'),mapScript);
for(const file of ['map.css','bridge.js'])fs.copyFileSync(path.join(source,file),path.join(target,'live',file));
for(const file of ['transit-data.js','schedule-data.js','intercity-data.js','popups.css','busTypes.json','bus_routes.geojson','frequent_routes.geojson','train_routes.geojson','train_stations.geojson','stops_bus.csv','stops_train.csv','stops_ferry.csv','stops.json','train.png','apple-touch-icon.png','icon-192.png','icon-512.png','icon-512-maskable.png','manifest.webmanifest']){
 const from=path.join(root,file);if(fs.existsSync(from))fs.copyFileSync(from,path.join(target,'live',file));
}
const hash=require('node:crypto').createHash('sha256');
for(const file of ['index.html','app.js','workspace.js','backend.js','config.js','style.css','performance.css','manifest.webmanifest','live/bridge.js','live/map.css','live/script.js','live/index.html','live/intercity-data.js','live/popups.css','live/schedule-data.js','live/transit-data.js'])hash.update(read(path.join(target,file)));
write(path.join(target,'sw.js'),read(path.join(source,'sw.js')).replace('__CACHE_VERSION__',hash.digest('hex').slice(0,12)));
console.log('Built combined AT-track workspace: performance/public/next/');
