const { extract } = require('./core.cjs');
const {scheduleRows,stopName,timetableIds}=require('./transfers.cjs');
const {requestTimetable}=require('./timetable.cjs');
const Positions=require('./positions.cjs');
const Occupancy=require('./occupancy.cjs');
const Trips=require('./trips.cjs');
const fs=require('node:fs'),path=require('node:path');
function loadTripAsset(name){try{return JSON.parse(fs.readFileSync(path.join(__dirname,'public/timetables',name),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
class Collector {
  constructor(store, { key = process.env.AT_API_KEY, proxy = process.env.AT_PROXY_URL, fetcher = fetch, interval = 20000 } = {}) {
    this.store=store; this.key=key; this.proxy=proxy?.replace(/\/$/,''); this.fetcher=fetcher; this.interval=interval;
    this.metadata=new Map(); this.routesTime=0; this.retryAt=0; this.running=false;
    this.status={ configured: Boolean(key || proxy), running: false, lastSuccess: store.getState('lastSuccess'), lastAttempt: null,
      error: key || proxy ? null : 'Set AT_API_KEY or AT_PROXY_URL in performance/.env to start collecting.', nextPoll: null };
  }
  async request(path) {
    const response=await this.fetcher(this.proxy ? `${this.proxy}/api/${path}` : `https://api.at.govt.nz/${path === 'routes' ? 'gtfs/v3/routes' : path==='realtime'?'realtime/legacy':'realtime/legacy/tripupdates'}`,
      { headers: this.proxy ? {} : { 'Ocp-Apim-Subscription-Key': this.key }, signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (response.status === 429) {
      const retry=response.headers.get('retry-after'), seconds=Number(retry);
      this.retryAt=Date.now()+Math.max(30000, Number.isFinite(seconds) ? seconds*1000 : (Date.parse(retry)||Date.now()+60000)-Date.now());
    }
    if (!response.ok) throw Error(`Transport API returned ${response.status}`);
    if (response.headers.get('x-cache')?.includes('stale')) throw Error('Transport proxy returned a stale snapshot');
    return await response.json();
  }
  async poll() {
    try{this.store.purgeHistory();delete this.status.retentionError;}catch(error){this.status.retentionError=error.message;}
    if (this.running || !this.status.configured || Date.now()<this.retryAt) return;
    this.running=true; this.status.running=true; this.status.lastAttempt=new Date().toISOString();
    try {
      if (Date.now()-this.routesTime>3600000) {
        const payload=await this.request('routes');
        if (!Array.isArray(payload.data)) throw Error('Route catalogue is missing its data list');
        const map=new Map(payload.data.map(r => [String(r.id),r.attributes ?? r]));
        if (!map.size) throw Error('Route catalogue is empty');
        this.metadata=map; this.routesTime=Date.now();
      }
      let payload,locationError=null;
      try{payload=await this.request('realtime');}catch(error){if(Date.now()<this.retryAt)throw error;locationError=error.message;payload=await this.request('tripupdates');}
      const batch=extract(payload,this.store.routes(),this.metadata);
      this.store.ingest(batch);
      try{this.status.timetablesArchived=await Trips.sync(this.store,this.store.routes(),batch,loadTripAsset);delete this.status.tripTimetableError;}catch(error){this.status.tripTimetableError=error.message;}
      this.store.setState('adherence',{lastSuccess:new Date().toISOString(),services:batch.adherence.map(s=>({...s,stopName:s.stopId?stopName(s.stopId):''}))});
      this.status.lastSuccess=new Date().toISOString(); this.status.error=null;
      this.status.lastBatch={ events: batch.events.length, cancellations: batch.cancellations.length, ignored: batch.ignored };
      this.store.setState('lastSuccess',this.status.lastSuccess);
      const location={lastAttempt:new Date().toISOString(),lastSuccess:null,error:locationError,vehicles:[],station:Positions.station};
      if(!locationError){try{location.vehicles=Positions.extract(payload,this.store.routes(),this.metadata);this.store.savePositions(location.vehicles);this.store.saveOccupancy(Occupancy.extract(payload,this.store.routes(),this.metadata));location.lastSuccess=new Date().toISOString();}catch(error){location.error=error.message;}}
      this.store.setState('positions',location);
      const previous=this.store.getState('timetable');
      if(!previous||previous.stopIds?.join(',')!==timetableIds.join(',')||Date.now()-Date.parse(previous.lastAttempt)>300000){
        const info={lastAttempt:new Date().toISOString(),lastSuccess:previous?.lastSuccess||null,error:null,complete:false,stopIds:timetableIds};
        try{const payload=await requestTimetable({proxy:this.proxy,key:this.key,fetcher:this.fetcher});
          this.store.saveSchedules(scheduleRows(payload,this.store.routes()));info.lastSuccess=new Date().toISOString();info.complete=payload.complete!==false;
          if(!info.complete)info.error='Papakura timetable is partial; captured services are retained';
        }catch(error){info.error=error.message;}
        this.store.setState('timetable',info);
      }
    } catch (error) { this.status.error=error.message; }
    finally { this.running=false; this.status.running=false; }
  }
  start() {
    this.stopped=false;
    const tick=async()=>{ await this.poll(); if(this.stopped)return; this.status.nextPoll=new Date(Math.max(Date.now()+this.interval,this.retryAt)).toISOString(); this.timer=setTimeout(tick,Math.max(this.interval,this.retryAt-Date.now())); };
    void tick();
  }
  stop() { this.stopped=true; clearTimeout(this.timer); }
}
module.exports={ Collector,loadTripAsset };
