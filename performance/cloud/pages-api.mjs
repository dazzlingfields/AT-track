import {CloudStore} from './store.mjs';
export function allowedOrigin(request,env){
 const origin=request.headers.get('origin');
 const allowed=String(env.PAGES_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
 return origin&&allowed.includes(origin)?origin:null;
}
export function withCors(response,origin){
 if(!origin)return response;
 const result=new Response(response.body,response);
 result.headers.set('Access-Control-Allow-Origin',origin);
 result.headers.set('Access-Control-Expose-Headers','Content-Disposition, Retry-After');
 result.headers.append('Vary','Origin');return result;
}
export function preflight(request,env){
 const origin=allowedOrigin(request,env);
 if(!origin)return new Response('Origin not allowed',{status:403});
 const method=request.headers.get('access-control-request-method');
 const headers=(request.headers.get('access-control-request-headers')||'').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
 if(!['GET','POST','PATCH'].includes(method)||headers.some(h=>!['authorization','content-type'].includes(h)))return new Response('Preflight not allowed',{status:403});
 return withCors(new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, POST, PATCH','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}}),origin);
}
// Public AT reference data only, never reports or credentials.
export async function cachedCatalogue(request,env,ctx,cache=globalThis.caches?.default){
 const url=new URL(request.url);url.search='';
 const cacheKey=new Request(url.href,{method:'GET'});
 const hit=cache?await cache.match(cacheKey):null;if(hit)return hit;
 const catalogue=await new CloudStore(env.DB).getState('catalogue');
 if(!Array.isArray(catalogue?.rows)||!catalogue.rows.length)return Response.json({error:'Route catalogue not available yet; awaiting collector refresh.'},{status:503,headers:{'Cache-Control':'no-store'}});
 const age=Date.now()-Number(catalogue.time);
 if(!Number.isFinite(age)||age<0||age>86400000)return Response.json({error:'Route catalogue is stale; awaiting collector refresh.'},{status:503,headers:{'Cache-Control':'no-store'}});
 const response=Response.json({data:catalogue.rows.map(([id,attributes])=>({id,attributes})),cachedAt:catalogue.time},{headers:{'Cache-Control':'public, max-age=60, s-maxage=300','X-Content-Type-Options':'nosniff'}});
 if(cache){const task=cache.put(cacheKey,response.clone());if(ctx?.waitUntil)ctx.waitUntil(task);else await task;}
 return response;
}
