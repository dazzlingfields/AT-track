// Extra permissions apply only to the embedded map, not the private report UI.
function contentSecurityPolicy(pathname){
  if(pathname==='/next/sw.js')return "default-src 'self'; script-src 'self'; connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://server.arcgisonline.com; base-uri 'none'; frame-ancestors 'none'; object-src 'none'";
  if(pathname.startsWith('/next/live/'))return "default-src 'self'; script-src 'self' https://unpkg.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://unpkg.com; connect-src 'self' https://atrealtime.vercel.app https://unpkg.com; img-src 'self' data: blob: https://unpkg.com https://*.basemaps.cartocdn.com https://*.tile.openstreetmap.org https://server.arcgisonline.com; base-uri 'none'; frame-ancestors 'self'; form-action 'self'; object-src 'none'";
  if(pathname==='/next'||pathname.startsWith('/next/'))return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
  return "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
}
module.exports={contentSecurityPolicy};
