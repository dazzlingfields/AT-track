const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const { Store,dateAt }=require('./core.cjs');
const { Collector,loadTripAsset }=require('./collector.cjs');
const Trips=require('./trips.cjs');
const Transfers=require('./transfers.cjs');
const Search=require('./search.cjs');
const { options,csvCell }=require('./http-utils.cjs');
const {contentSecurityPolicy}=require('./web-policy.cjs');
async function body(req) {
  let text=''; for await (const chunk of req) { text+=chunk; if (text.length>8192) throw Error('Request body too large'); }
  return JSON.parse(text || '{}');
}
function createServer(store,collector) {
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const json=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      const url=new URL(req.url,'http://localhost');
      if (req.method==='POST' || req.method==='PATCH') {
        // Local dashboard mutations are same-origin only. No public write API.
        if (req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`) return json({error:'Cross-origin writes are blocked'},403);
        if (!req.headers['content-type']?.startsWith('application/json')) return json({error:'Use application/json'},415);
      }
      if (req.method==='GET' && url.pathname==='/api/status') return json({...collector.status,retention:store.getState('retention'),today:dateAt(Date.now()/1000),intervalSeconds:collector.interval/1000});
      if (req.method==='GET' && url.pathname==='/api/occupancy') return json(store.occupancy(options(url)));
      if (req.method==='GET' && url.pathname==='/api/routes') return json(store.routes());
      if (req.method==='GET' && ['/api/trips','/api/trip'].includes(url.pathname)) return json(await Trips.view(store,Trips.options(url),loadTripAsset));
      if (req.method==='POST' && url.pathname==='/api/routes') {store.addRoute(await body(req));return json(store.routes(),201);}
      if (req.method==='PATCH' && /^\/api\/routes\/\d+$/.test(url.pathname)) {
        const data=await body(req); if (typeof data.active!=='boolean') throw Error('active must be true or false');
        const changed=store.toggle(Number(url.pathname.split('/').pop()),data.active); return changed.changes ? json(store.routes()) : json({error:'Route not found'},404);
      }
      if (req.method==='GET' && url.pathname==='/api/report') return json(store.report(options(url)));
      if (req.method==='GET' && url.pathname==='/api/transfers') return json(store.transfers({...options(url),...Transfers.transferOptions(url)}));
      if (req.method==='GET' && url.pathname==='/api/export') {
        const filters=options(url),{where,params}=Search.eventSql(filters),rows=store.db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY event_time DESC`).all(...params);
        const names=new Map(store.routes().map(r=>[r.id,r.code]));
        const columns=['route','trip_id','service_date','start_time','stop_id','sequence','kind','event_time','scheduled_time','delay_sec','reported_at'];
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="route-performance.csv"'});
        res.end([columns.join(','),...rows.map(r=>columns.map(c=>csvCell(c==='route'?names.get(r.route_id):r[c])).join(','))].join('\r\n')); return;
      }
      if(req.method==='GET'&&url.pathname==='/next'){res.writeHead(302,{Location:'/next/'});res.end();return;}
      if(req.method==='GET'&&url.pathname.startsWith('/next/')){
        const publicRoot=path.resolve(__dirname,'public/next');
        const relative=decodeURIComponent(url.pathname.slice('/next/'.length)).replace(/\/$/,'/index.html')||'index.html';
        const filename=path.resolve(publicRoot,relative);
        if(!filename.startsWith(publicRoot+path.sep)||!fs.existsSync(filename)||!fs.statSync(filename).isFile())return json({error:'Not found'},404);
        const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.geojson':'application/geo+json','.csv':'text/csv','.png':'image/png','.webmanifest':'application/manifest+json'};
        const type=types[path.extname(filename)];if(!type)return json({error:'Not found'},404);
        res.setHeader('Content-Type',type);res.setHeader('Content-Security-Policy',contentSecurityPolicy(url.pathname));
        fs.createReadStream(filename).pipe(res);return;
      }
      const files={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if (req.method!=='GET'||!files[url.pathname]) return json({error:'Not found'},404);
      const file=files[url.pathname];
      res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css':'text/javascript');
      res.setHeader('Content-Security-Policy',contentSecurityPolicy(url.pathname));
      res.end(fs.readFileSync(path.join(__dirname,'public',file)));
    } catch (error) { json({error:error.message},400); }
  });
}
if (require.main===module) {
  const filename=process.env.DB_PATH?path.resolve(process.env.DB_PATH):path.join(__dirname,'data','performance.sqlite');
  fs.mkdirSync(path.dirname(filename),{recursive:true});
  const store=new Store(filename),interval=Math.max(20,Number(process.env.POLL_SECONDS)||20)*1000;
  const collector=new Collector(store,{interval}), server=createServer(store,collector);
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT)||3080;
  server.listen(port,host,()=>{console.log(`Route performance: http://${host}:${port}`);console.log(collector.status.configured?'Collector enabled; keep this process running to record history.':collector.status.error);collector.start();});
  const shutdown=()=>{collector.stop();server.close(()=>{store.close();process.exit(0);});};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
module.exports={createServer,options,csvCell};
