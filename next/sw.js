// Offline shell and map references only. Never store report APIs, live feeds,
// authentication failures or mutations. Separate names/scope protect the old app.
const VERSION='pages-c501e1cb17ab',SHELL='at-workspace-shell-'+VERSION,TILES='at-workspace-tiles-'+VERSION;
const ASSETS=['/AT-track/next/','/AT-track/next/index.html','/AT-track/next/app.js','/AT-track/next/workspace.js','/AT-track/next/style.css','/AT-track/next/performance.css','/AT-track/next/manifest.webmanifest','/AT-track/next/live/index.html','/AT-track/next/live/script.js','/AT-track/next/live/transit-data.js','/AT-track/next/live/schedule-data.js','/AT-track/next/live/map.css','/AT-track/next/live/bridge.js','/AT-track/next/live/icon-192.png','/AT-track/next/live/icon-512.png','https://unpkg.com/leaflet@1.7.1/dist/leaflet.js','https://unpkg.com/leaflet@1.7.1/dist/leaflet.css','https://unpkg.com/leaflet@1.7.1/dist/images/layers.png'];
ASSETS.push('/AT-track/next/config.js','/AT-track/next/backend.js');
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(SHELL);await Promise.allSettled(ASSETS.map(async url=>{const response=await fetch(url,{cache:'reload'});if(response.ok)await cache.put(new URL(url,self.location.origin).href,response);}));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('at-workspace-')&&![SHELL,TILES].includes(name))await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.pathname.startsWith('/api/')||url.hostname==='atrealtime.vercel.app')return;
 const local=url.origin===self.location.origin&&url.pathname.startsWith('/AT-track/next/')&&!url.pathname.endsWith('/sw.js');
 const dependency=['unpkg.com','cdn.jsdelivr.net'].includes(url.hostname);
 const tile=url.hostname.endsWith('.basemaps.cartocdn.com')||url.hostname.endsWith('.tile.openstreetmap.org')||url.hostname==='server.arcgisonline.com';
 if(!local&&!dependency&&!tile)return;
 event.respondWith((async()=>{
  const cache=await caches.open(tile?TILES:SHELL),cached=await cache.match(url.href);
  if(tile&&cached)return cached;
  try{
   const response=await fetch(request);
   // Authentication failures are authoritative, including when a cached shell exists.
   if(response.status===401||response.status===403)return response;
   if(response.ok||response.type==='opaque')event.waitUntil((async()=>{await cache.put(url.href,response.clone());if(tile){const keys=await cache.keys();for(const old of keys.slice(0,Math.max(0,keys.length-300)))await cache.delete(old);}})().catch(()=>{}));
   return response;
  }catch{return cached||Response.error();}
 })());
});
