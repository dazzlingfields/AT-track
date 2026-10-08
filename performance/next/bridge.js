// The maintained live map runs in an isolated same-origin document. All cross-
// workspace messages validate both the origin and the owning window.
(() => {
  'use strict';
  const send=data=>{if(parent!==window)parent.postMessage({source:'at-track-map',...data},location.origin);};
  const text=html=>{const template=document.createElement('template');template.innerHTML=html||'';return template.content.textContent.replace(/\s+/g,' ').trim();};
  const key=value=>String(value||'').replace(/[^a-z0-9]/gi,'').toUpperCase();
  let selected=null,workspaceVisible=true,lastStatus='',selectedStamp='';
  function emitSelection(marker){
    if(!marker?.tripId)return;
    selected=marker;
    const vehicle={routeCode:marker.routeName,mode:marker.currentType,vehicle:marker.vehicleLabel,tripId:marker.tripId,serviceDate:marker.serviceDate,startTime:marker.tripStart,destination:marker.destination,delay:Number.isFinite(marker.delaySec)?marker.delaySec:null,occupancy:marker.occupancy,speed:marker.speedStr,fleet:marker.busType,stop:text(marker.nextStopLine)};
    const stamp=JSON.stringify(vehicle);if(stamp!==selectedStamp){selectedStamp=stamp;send({type:'selection',vehicle});}
  }
  map.on('popupopen',event=>emitSelection(event.popup?._source));
  document.addEventListener('click',event=>{
    if(!event.target.closest('.workspace-service-link'))return;
    event.preventDefault();event.stopPropagation();
    if(selected){emitSelection(selected);send({type:'open-service'});}
  });
  function emitStatus(){
    const layers={};for(const mode of ['bus','train','ferry'])layers[mode]=Boolean(document.querySelector(`input[data-layer="${mode}"]`)?.checked);
    const state={type:'status',state:document.getElementById('live-status').dataset.state,label:document.getElementById('status-label').textContent,updated:document.getElementById('status-update').textContent,layers};
    const stamp=JSON.stringify(state);if(stamp!==lastStatus){lastStatus=stamp;send(state);}
    if(selected)emitSelection(selected);
  }
  function setLayer(mode,enabled){const input=document.querySelector(`input[data-layer="${mode}"]`);if(!input)return;input.checked=enabled;input.dispatchEvent(new Event('change',{bubbles:true}));emitStatus();}
  function focusRoute(code,mode){
    if(mode)setLayer(mode,true);
    const matches=Object.values(vehicleMarkers).filter(marker=>key(marker.routeName)===key(code));
    setRouteFocusEnabled(true);focusedRouteKey=normalizeRouteKey(matches[0]?.routeName||code);applyRouteFocus();
    const focusInput=document.querySelector('input[data-layer="focus"]');if(focusInput)focusInput.checked=true;
    if(matches.length){map.fitBounds(L.latLngBounds(matches.map(marker=>marker.getLatLng())).pad(.3),{maxZoom:14});const marker=matches[0];pinnedPopup=marker;pinnedFollow=true;marker.openPopup();showRouteOutlineFor(marker);emitSelection(marker);}
    send({type:'route-result',code,found:matches.length>0});
  }
  window.addEventListener('message',event=>{
    if(event.origin!==location.origin||event.source!==parent||event.data?.source!=='at-track-workspace')return;
    const message=event.data;
    if(message.type==='layer'&&['bus','train','ferry'].includes(message.mode)&&typeof message.enabled==='boolean')setLayer(message.mode,message.enabled);
    if(message.type==='refresh')document.getElementById('refresh-vehicles').click();
    if(message.type==='route'&&typeof message.code==='string')focusRoute(message.code,message.mode);
    if(message.type==='visibility'){
      workspaceVisible=Boolean(message.visible);
      window.atWorkspaceVisible=workspaceVisible;
      if(workspaceVisible){map.invalidateSize();if(document.visibilityState==='visible')void resumeUpdatesNow();}
      else pauseUpdatesNow();
    }
  });
  const controls=document.getElementById('controls');controls.classList.add('collapsed');document.getElementById('controls-toggle').setAttribute('aria-expanded','false');updateControlsHeight();
  new MutationObserver(emitStatus).observe(document.getElementById('live-status'),{attributes:true,childList:true,subtree:true,characterData:true});
  document.querySelectorAll('input[data-layer]').forEach(input=>input.addEventListener('change',emitStatus));
  document.addEventListener('visibilitychange',()=>{if(!workspaceVisible)pauseUpdatesNow();});
  setInterval(()=>{emitStatus();if(!workspaceVisible)pauseUpdatesNow();},3000);
  emitStatus();send({type:'ready'});
})();
