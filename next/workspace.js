(() => {
  'use strict';
  const el=id=>document.getElementById(id), frame=el('network-map');
  const labels={live:['Live network','Every journey, in context.'],overview:['Your routes','The routes you take. The story behind every stop.'],route:['Route workspace','Live context, measured performance and recorded stop timings.'],trips:['Trip explorer','Choose a departure. Follow its journey, stop by stop.'],transfers:['Papakura connections','Did your services connect? Follow the timing evidence.'],services:['Service rankings','The early, the late, and the evidence behind them.'],stops:['Stop performance','See where your route gains and loses time.'],occupancy:['Occupancy','Available space across the routes you travel.'],history:['Observation history','Your searchable record of reported stop events.'],settings:['Your analysis settings','Set the window that makes sense for your journey.']};
  labels.service=['Selected service','Live vehicle details, route performance and recorded trips.'];
  let ready=false, pendingCommands=[], selection=null;
  let mapState='loading', mapStatus=null, selectionKey='', trackedRoutes=[];
  const codeKey=value=>String(value||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
  function element(tag,text,className){const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;}
  function button(text,action,className){const node=element('button',text,className);node.type='button';node.onclick=action;return node;}
  function send(command){if(!ready){pendingCommands.push(command);return;}frame.contentWindow.postMessage({source:'at-track-workspace',...command},location.origin);}
  function ensureMap(){if(frame.getAttribute('src'))return;frame.src=frame.dataset.src;}
  function showMap(route){window.ATWorkspace.setView('live');ensureMap();send({type:'route',code:route.code,mode:route.mode});}
  function updateClock(){el('auckland-clock').textContent=new Intl.DateTimeFormat('en-NZ',{timeZone:'Pacific/Auckland',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date())+' · Auckland';}
  updateClock();setInterval(updateClock,30000);
  document.addEventListener('workspace:view',event=>{
    const view=event.detail, [title,subtitle]=labels[view]||labels.live;
    el('workspace-title').replaceChildren(document.createTextNode(title),element('span','.','title-dot'));
    el('workspace-subtitle').textContent=subtitle;el('breadcrumb-view').textContent=title;document.title='AT-track · '+title;
    if(view==='live'){ensureMap();if(window.ATWorkspace?.getToday())void window.ATWorkspace.refresh(true);}
    send({type:'visibility',visible:view==='live'});
    if(view==='settings')document.querySelector('.settings').open=true;
    const active=document.querySelector('.workspace-nav button.active');if(active&&innerWidth<701)active.scrollIntoView({block:'nearest',inline:'nearest'});
  });
  document.addEventListener('workspace:status',event=>{
    const status=event.detail,age=status.lastSuccess?Date.now()-Date.parse(status.lastSuccess):Infinity;
    const healthy=Boolean(status.configured&&!status.error&&age<150000);
    el('collector-label').textContent=healthy?'Collector active':status.error?'Collection interrupted':status.configured?'Awaiting collector':'Collector setup needed';
    document.querySelector('.collector-box').classList.toggle('is-live',healthy);
    trackedRoutes=window.ATWorkspace?.getRoutes()||trackedRoutes;
    renderSelection();
  });
  document.addEventListener('workspace:report',()=>{
    const routes=window.ATWorkspace?.getRoutes()||[];
    for(const card of document.querySelectorAll('#route-cards .route-card')){
      const route=routes.find(r=>r.code===card.querySelector('.badge')?.textContent);if(!route)continue;
      card.append(button('Show live vehicles ↗',()=>showMap(route),'text-button'));
    }
  });
  function routeForSelection(){return (window.ATWorkspace?.getRoutes()||trackedRoutes).find(route=>codeKey(route.code)===codeKey(selection?.routeCode));}
  function delayText(value){return typeof value!=='number'||!Number.isFinite(value)?'Unknown':value===0?'On time':(Math.abs(value)/60).toFixed(1)+' min '+(value<0?'early':'late');}
  function renderSelection(){
    if(!selection)return;
    const root=el('selected-service');root.replaceChildren();
    root.append(element('span',selection.routeCode||'Unknown route','live-route-badge'),element('h3',selection.destination||'Destination unavailable','service-destination'),element('div',[selection.mode,selection.vehicle||'Vehicle not labelled'].filter(Boolean).join(' · '),'service-vehicle'));
    const stale=mapState!=='live';if(stale)root.append(element('p','Saved or stale position · current timings may be unavailable','service-stale'));
    const facts=element('dl',null,'service-facts');
    for(const [label,value] of [['Reported stop delay',stale?'Unavailable':delayText(selection.delay)],['Occupancy',!selection.occupancy||selection.occupancy==='N/A'?'Unknown':selection.occupancy],['Speed',selection.speed||'Unknown'],['Fleet',selection.fleet||'Not supplied']]){const fact=element('div');fact.append(element('dt',label),element('dd',value));facts.append(fact);}
    root.append(facts,element('p',selection.stop||'No latest stop supplied','service-note'),element('p','Delay is at the latest reported stop. It is not a prediction for every later stop.','service-note'));
    const actions=element('div',null,'service-actions'),route=routeForSelection();
    if(route){
      actions.append(button('Route performance →',()=>void window.ATWorkspace.openRoute(route.id),'primary'));
      if(selection.tripId)actions.append(button('View recorded trip →',async()=>{
        const date=/^\d{8}$/.test(selection.serviceDate||'')?selection.serviceDate.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3'):window.ATWorkspace.getToday();
        await window.ATWorkspace.openTrip(route.id,date,selection.tripId,selection.startTime||undefined);
      }));
    }else{
      actions.append(element('p','This route is not tracked yet. Add it to collect future stop events.','service-note'));
      if(['bus','train'].includes(selection.mode)&&selection.routeCode){
        actions.append(button('Track route '+selection.routeCode,async event=>{
          const action=event.currentTarget,chosen={...selection};action.disabled=true;
          try{await window.ATWorkspace.track({mode:chosen.mode,code:chosen.routeCode,name:chosen.routeCode+' · '+(chosen.destination||'Route')});await window.ATWorkspace.refresh(true);renderSelection();}
          catch(error){root.append(element('p',error.message,'service-stale'));}finally{action.disabled=false;}
        },'primary'));
      }
    }
    root.append(actions);
  }
  function updateMapStatus(status){
    mapStatus=status;mapState=status.state;el('map-state').dataset.state=mapState;
    el('map-state').textContent=status.label;el('map-updated').textContent=status.updated;
    for(const chip of document.querySelectorAll('[data-map-mode]'))chip.setAttribute('aria-pressed',String(Boolean(status.layers[chip.dataset.mapMode])));
    renderSelection();
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.source!=='at-track-map')return;
    const data=event.data;
    if(data.type==='ready'){ready=true;el('map-unavailable').hidden=true;for(const command of pendingCommands)send(command);pendingCommands=[];send({type:'visibility',visible:document.body.dataset.view==='live'});}
    if(data.type==='status')updateMapStatus(data);
    if(data.type==='open-service')window.ATWorkspace.setView('service');
    if(data.type==='selection'){
      selection=data.vehicle;const key=selection.tripId+'|'+selection.vehicle;
      if(key!==selectionKey){selectionKey=key;renderSelection();}else renderSelection();
    }
    if(data.type==='route-result'&&!data.found){el('map-state').textContent='No visible live vehicles for '+data.code;}
  });
  frame.addEventListener('load',()=>{setTimeout(()=>{if(!ready&&frame.src)el('map-unavailable').hidden=false;},10000);});
  el('map-retry').onclick=()=>{ready=false;frame.src=frame.dataset.src;el('map-unavailable').hidden=true;};
  for(const chip of document.querySelectorAll('[data-map-mode]'))chip.onclick=()=>{const enabled=chip.getAttribute('aria-pressed')!=='true';send({type:'layer',mode:chip.dataset.mapMode,enabled});};
  el('workspace-refresh').onclick=async()=>{
    const action=el('workspace-refresh');action.disabled=true;send({type:'refresh'});
    try{await window.ATWorkspace.refresh(true);}finally{action.disabled=false;}
  };
  const mapButton=button('Show live vehicles ↗',()=>{
    const route=(window.ATWorkspace.getRoutes()||[]).find(r=>String(r.id)===el('route').value);if(route)showMap(route);
  },'route-map-button');el('route-context').append(mapButton);
  if(!location.hash||location.hash==='#live')ensureMap();
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&mapStatus)renderSelection();});
  if('serviceWorker' in navigator)window.addEventListener('load',()=>{navigator.serviceWorker.register('/AT-track/next/sw.js',{scope:'/AT-track/next/'}).catch(()=>{});});
})();
