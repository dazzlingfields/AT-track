// The alarm executes outside the lightweight dashboard/cron Worker's CPU budget.
export function collectorClass(sample,cleanup,clock=Date.now){
 return class PerformanceCollector {
  constructor(ctx,env){this.ctx=ctx;this.env=env;this.running=false;}
  async fetch(){
   const next=await this.ctx.storage.getAlarm();
   if(!this.running&&(next==null||next<clock()-60000))await this.ctx.storage.setAlarm(clock()+1000);
   return new Response(JSON.stringify({scheduled:true}),{headers:{'Content-Type':'application/json'}});
  }
  async alarm(){
   if(this.running)return;
   this.running=true;
   // Rearm before external work so an unexpected termination cannot strand collection.
   const started=clock();await this.ctx.storage.setAlarm(started+20000);
   try{
    try{await cleanup(this.env,started);}catch(error){console.error(JSON.stringify({event:'retention_failed',message:error.message}));}
    const status=await sample(this.env,started);
    const next=Math.max(started+20000,clock()+1000,status?.retryAt||0);
    await this.ctx.storage.setAlarm(next);
   }finally{this.running=false;}
  }
 };
}
