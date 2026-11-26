import {displayServerName,renderFlag} from './flags.js';
import {latencyClass} from './model.js';
import {createRepository,STORAGE_KEY} from './store.js';
import {APPEARANCE_KEY,paintAppearance,restoreAppearance,savedPreferences} from './theme.js';
import {outageLabel,trayConnectionAction,trayServers} from './tray-panel-model.js';

const $=id=>document.getElementById(id);
const search=$('traySearch');
const groups=$('trayGroups');
const list=$('trayServers');
const rows=$('trayRows');
const systemLight=window.matchMedia('(prefers-color-scheme: light)');
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
const globe='<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 0 0 18m0-18a15 15 0 0 1 0 18"/></svg>';
const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
const rowHeight=parseFloat(getComputedStyle(document.body).getPropertyValue('--tray-row-height'));
let appearance=restoreAppearance(savedPreferences(localStorage));
let snapshot={};
let catalog=[];
let group='all';
let results=[];
let keyboardServerId=null;
const visibleRows=new Map();
let paintPending=false;
let lastListState='';

function theme(){
  paintAppearance(document.documentElement,appearance,systemLight.matches);
}

function component(tag,className,content){
  const node=document.createElement(tag);
  node.className=className;
  if(content!=null)node.textContent=content;
  return node;
}

function showError(message){
  $('trayError').textContent=message;
  $('trayError').hidden=!message;
}

async function action(kind,serverId=null){
  const connectionAction=['connect','disconnect','retry','switch','restoreProxy'].includes(kind);
  if(snapshot.busy&&connectionAction&&!(snapshot.pendingId&&kind==='connect'))return;
  if(kind!=='refresh')showError('');
  try{await invoke('tray_panel_action',{action:kind,serverId})}
  catch(error){if(kind!=='refresh')showError(String(error?.message??error))}
}

function installMarquee(wrapper,focusTarget=wrapper){
  const start=()=>{
    if(reducedMotion.matches){wrapper.title=wrapper.textContent;return}
    const distance=wrapper.scrollWidth-wrapper.clientWidth;
    if(distance<2)return;
    wrapper.style.setProperty('--tray-pan-distance',`-${distance}px`);
    wrapper.style.setProperty('--tray-pan-duration',`${Math.max(3,distance/34+2)}s`);
    wrapper.classList.add('marquee-running');
  };
  const stop=()=>wrapper.classList.remove('marquee-running');
  wrapper.addEventListener('pointerenter',start);
  wrapper.addEventListener('pointerleave',stop);
  focusTarget.addEventListener('focusin',start);
  focusTarget.addEventListener('focusout',stop);
}

function renderStatus(){
  const server=catalog.find(row=>row.id===snapshot.serverId);
  const name=server?displayServerName(server):snapshot.activeId?'Active server':'No server selected';
  const label=$('trayActiveName');
  if(label.firstElementChild.textContent!==name){
    label.classList.remove('marquee-running');
    label.removeAttribute('title');
    label.firstElementChild.textContent=name;
  }
  renderFlag($('trayActiveFlag'),server,globe);
  $('trayMode').textContent=snapshot.connectionMode==='tun'?'TUN':'System Proxy';
  $('trayConnection').dataset.state=snapshot.proxyInactive?'proxy-inactive':snapshot.retry?'unhealthy':snapshot.connected?'healthy':'idle';
  const state=snapshot.busy||(snapshot.proxyInactive?'Proxy inactive':snapshot.retry?'Not responding':snapshot.connected?'Connected':'Disconnected');
  const latency=snapshot.activeId?snapshot.latencyMs:server?.latency;
  const detail=[state,Number.isFinite(latency)?`${latency} ms`:null,
    snapshot.outageSeconds!=null?`${outageLabel(snapshot.outageSeconds)} outage`:null].filter(Boolean).join(' · ');
  if($('trayState').textContent!==detail)$('trayState').textContent=detail;
  $('trayState').title=detail;
  const command=trayConnectionAction(snapshot);
  $('trayConnect').textContent=snapshot.busy&&!snapshot.pendingId?'Working…':command.label;
  $('trayConnect').disabled=Boolean((snapshot.busy&&!snapshot.pendingId)||(command.action==='connect'&&!command.serverId));
  $('trayConnect').dataset.primary=String(command.primary);
  $('trayConnect').onclick=()=>void action(command.action,command.serverId);
  showError(snapshot.error??'');
}

function selectServer(serverId){
  if(serverId==null||serverId===snapshot.pendingId)return;
  if(snapshot.pendingId){void action('connect',serverId);return}
  if(serverId===snapshot.activeId){
    if(snapshot.proxyInactive)void action('restoreProxy');
    else if(snapshot.retry)void action('retry',serverId);
    return;
  }
  void action(serverId===snapshot.suggestion?.serverId?'switch':'connect',serverId);
}

function makeRow(serverId){
  const button=component('button','tray-row');
  button.type='button';
  const flag=component('span','tray-flag');
  const copy=component('span','tray-server-copy');
  const frame=component('span','tray-name');
  const value=component('span','');
  value.dir='auto';
  const suggestion=component('span','tray-suggest-label','Suggested');
  const latency=component('span','tray-latency');
  const indicator=component('span','');
  frame.append(value);
  copy.append(frame,suggestion);
  button.append(flag,copy,latency,indicator);
  installMarquee(frame,button);
  button.addEventListener('click',()=>selectServer(serverId));
  return {button,flag,frame,value,suggestion,latency,indicator};
}

function updateRow(row,server,index){
  const {button,flag,frame,value,suggestion,latency,indicator}=row;
  const proposed=server.id===snapshot.suggestion?.serverId;
  const active=server.id===snapshot.activeId;
  button.disabled=Boolean(snapshot.busy&&(!snapshot.pendingId||server.id===snapshot.pendingId));
  button.style.top=`${index*rowHeight}px`;
  button.classList.toggle('suggested',proposed);
  button.classList.toggle('keyboard-selected',server.id===keyboardServerId);
  const name=displayServerName(server);
  if(value.textContent!==name){
    frame.classList.remove('marquee-running');
    frame.removeAttribute('title');
    value.textContent=name;
  }
  button.setAttribute('aria-label',proposed?`Switch to ${name}, suggested server`:active?`${name}, current server`:`Connect to ${name}`);
  if(active)button.setAttribute('aria-current','true');
  else button.removeAttribute('aria-current');
  renderFlag(flag,server,globe);
  suggestion.hidden=!proposed;
  const ms=proposed?snapshot.suggestion.candidateMs:active?snapshot.latencyMs??server.latency:server.latency;
  latency.className=`tray-latency ${latencyClass(ms)}`;
  latency.textContent=Number.isFinite(ms)?`${ms} ms`:'—';
  indicator.className=proposed?'tray-switch-label':active?'tray-active-check':'';
  indicator.hidden=!proposed&&!active;
  indicator.textContent=proposed?'Switch':active?'✓':'';
}

function drawRows(){
  const start=Math.max(0,Math.floor(list.scrollTop/rowHeight)-2);
  const windowed=results.slice(start,start+10);
  const wanted=new Set(windowed.map(server=>server.id));
  for(const [id,row] of visibleRows){
    if(wanted.has(id))continue;
    row.button.remove();
    visibleRows.delete(id);
  }
  for(const [offset,server] of windowed.entries()){
    const row=visibleRows.get(server.id)??makeRow(server.id);
    visibleRows.set(server.id,row);
    updateRow(row,server,start+offset);
    const position=rows.children[offset];
    if(position!==row.button)rows.insertBefore(row.button,position??null);
  }
}

function updateList(resetScroll=false){
  results=trayServers(catalog,{group,query:search.value,suggestion:snapshot.suggestion});
  if(resetScroll){list.scrollTop=0;keyboardServerId=null;}
  if(!results.some(server=>server.id===keyboardServerId))keyboardServerId=null;
  $('trayEmpty').hidden=results.length>0;
  rows.style.height=`${results.length*rowHeight}px`;
  drawRows();
}

function readCatalog(resetScroll=false){
  const repository=createRepository(localStorage);
  catalog=repository.rows();
  const filters=[
    ['all','All servers'],['pinned','Pinned'],['favorites','Favorites'],
    ...repository.snapshot().subscriptions.map(item=>[`subscription:${item.id}`,item.name])
  ];
  if(!filters.some(([key])=>key===group))group='all';
  $('trayGroupLabel').firstElementChild.textContent=filters.find(([key])=>key===group)[1];
  $('trayGroupOptions').replaceChildren(...filters.map(([key,label])=>{
    const button=component('button','',label);
    button.type='button';button.title=label;
    button.setAttribute('aria-pressed',String(group===key));
    button.addEventListener('click',()=>{
      group=key;groups.open=false;
      $('trayGroupLabel').firstElementChild.textContent=label;
      for(const option of $('trayGroupOptions').children)option.setAttribute('aria-pressed',String(option===button));
      updateList(true);
      search.focus();
    });
    return button;
  }));
  renderStatus();
  updateList(resetScroll);
}

function refresh(){
  appearance=restoreAppearance(savedPreferences(localStorage));
  theme();
  groups.open=false;
  readCatalog(true);
  void action('refresh');
}

window.addEventListener('simpleray:tray-panel-snapshot',event=>{
  snapshot=event.detail;
  if(snapshot.appearance){appearance=restoreAppearance(snapshot.appearance);theme()}
  renderStatus();
  const next=JSON.stringify([snapshot.activeId,snapshot.busy,snapshot.pendingId,snapshot.latencyMs,snapshot.suggestion]);
  if(next!==lastListState){lastListState=next;updateList()}
});
window.addEventListener('storage',event=>{
  if(event.key===STORAGE_KEY)readCatalog();
  if(event.key===APPEARANCE_KEY){appearance=restoreAppearance(savedPreferences(localStorage));theme()}
});
systemLight.addEventListener('change',theme);
window.addEventListener('focus',refresh);
search.addEventListener('input',()=>updateList(true));
search.addEventListener('keydown',event=>{
  if(event.isComposing||event.keyCode===229||!results.length)return;
  if(event.key==='Enter'){
    event.preventDefault();
    selectServer(keyboardServerId??results[0].id);
    return;
  }
  if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
  event.preventDefault();
  const previous=results.findIndex(server=>server.id===keyboardServerId);
  const index=Math.min(results.length-1,Math.max(0,previous+(event.key==='ArrowDown'?1:-1)));
  keyboardServerId=results[index].id;
  const top=index*rowHeight;
  if(top<list.scrollTop)list.scrollTop=top;
  else if(top+rowHeight>list.scrollTop+list.clientHeight)list.scrollTop=top+rowHeight-list.clientHeight;
  drawRows();
});
list.addEventListener('scroll',()=>{
  if(paintPending)return;
  paintPending=true;
  requestAnimationFrame(()=>{paintPending=false;drawRows()});
});
document.addEventListener('click',event=>{if(!groups.contains(event.target))groups.open=false;});
document.addEventListener('keydown',event=>{
  if(event.isComposing||event.key!=='Escape')return;
  if(groups.open){groups.open=false;$('trayGroupLabel').focus()}
  else void action('close');
});
$('trayOpen').addEventListener('click',()=>void action('open'));
$('trayExit').addEventListener('click',()=>void action('exit'));
installMarquee($('trayActiveName'));
refresh();
