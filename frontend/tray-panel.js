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
let keyboardIndex=-1;
let windowKey='';
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
  if(snapshot.busy&&kind!=='exit'&&kind!=='close'&&kind!=='refresh')return;
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
  $('trayConnection').dataset.state=snapshot.retry?'unhealthy':snapshot.connected?'healthy':'idle';
  const state=snapshot.busy|| (snapshot.retry?'Not responding':snapshot.connected?'Connected':'Disconnected');
  const latency=snapshot.activeId?snapshot.latencyMs:server?.latency;
  const detail=[state,Number.isFinite(latency)?`${latency} ms`:null,
    snapshot.outageSeconds!=null?`${outageLabel(snapshot.outageSeconds)} outage`:null].filter(Boolean).join(' · ');
  if($('trayState').textContent!==detail)$('trayState').textContent=detail;
  $('trayState').title=detail;
  const command=trayConnectionAction(snapshot);
  $('trayConnect').textContent=snapshot.busy?'Working…':command.label;
  $('trayConnect').disabled=Boolean(snapshot.busy||(command.action!=='disconnect'&&!command.serverId));
  $('trayConnect').dataset.primary=String(command.primary);
  $('trayConnect').onclick=()=>void action(command.action,command.serverId);
  showError(snapshot.error??'');
}

function selectServer(index){
  const server=results[index];
  if(!server)return;
  const suggested=server.id===snapshot.suggestion?.serverId;
  if(server.id===snapshot.activeId){
    if(snapshot.retry)void action('retry',server.id);
    return;
  }
  void action(suggested?'switch':'connect',server.id);
}

function makeRow(server,index){
  const proposed=server.id===snapshot.suggestion?.serverId;
  const active=server.id===snapshot.activeId;
  const button=component('button','tray-row');
  button.type='button';
  button.disabled=Boolean(snapshot.busy);
  button.style.top=`${index*rowHeight}px`;
  button.classList.toggle('suggested',proposed);
  button.classList.toggle('keyboard-selected',index===keyboardIndex);
  const name=displayServerName(server);
  button.setAttribute('aria-label',proposed?`Switch to ${name}, suggested server`:active?`${name}, current server`:`Connect to ${name}`);
  if(active)button.setAttribute('aria-current','true');
  const flag=component('span','tray-flag');
  renderFlag(flag,server,globe);
  const copy=component('span','tray-server-copy');
  const frame=component('span','tray-name');
  const value=component('span','',name);
  value.dir='auto';
  frame.append(value);
  copy.append(frame);
  if(proposed)copy.append(component('span','tray-suggest-label','Suggested'));
  const latency=proposed?snapshot.suggestion.candidateMs:active?snapshot.latencyMs??server.latency:server.latency;
  button.append(flag,copy,component('span',`tray-latency ${latencyClass(latency)}`,Number.isFinite(latency)?`${latency} ms`:'—'));
  if(proposed)button.append(component('span','tray-switch-label','Switch'));
  else if(active)button.append(component('span','tray-active-check','✓'));
  installMarquee(frame,button);
  button.addEventListener('click',()=>selectServer(index));
  return button;
}

function drawRows(){
  const start=Math.max(0,Math.floor(list.scrollTop/rowHeight)-2);
  const end=Math.min(results.length,start+10);
  const key=`${start}:${end}:${keyboardIndex}:${lastListState}`;
  if(key===windowKey)return;
  windowKey=key;
  rows.replaceChildren(...results.slice(start,end).map((server,index)=>makeRow(server,start+index)));
}

function updateList(resetScroll=false){
  results=trayServers(catalog,{group,query:search.value,suggestion:snapshot.suggestion});
  if(resetScroll){list.scrollTop=0;keyboardIndex=-1;}
  if(keyboardIndex>=results.length)keyboardIndex=-1;
  $('trayEmpty').hidden=results.length>0;
  rows.style.height=`${results.length*rowHeight}px`;
  windowKey='';
  drawRows();
}

function readCatalog(){
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
  updateList();
}

function refresh(){
  appearance=restoreAppearance(savedPreferences(localStorage));
  theme();
  readCatalog();
  void action('refresh');
}

window.addEventListener('simpleray:tray-panel-snapshot',event=>{
  snapshot=event.detail;
  if(snapshot.appearance){appearance=restoreAppearance(snapshot.appearance);theme()}
  renderStatus();
  const next=JSON.stringify([snapshot.activeId,snapshot.busy,snapshot.latencyMs,snapshot.suggestion]);
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
  if(!results.length)return;
  if(event.key==='Enter'){
    event.preventDefault();
    selectServer(Math.max(0,keyboardIndex));
    return;
  }
  if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
  event.preventDefault();
  keyboardIndex=Math.min(results.length-1,Math.max(0,keyboardIndex+(event.key==='ArrowDown'?1:-1)));
  const top=keyboardIndex*rowHeight;
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
  if(event.key!=='Escape')return;
  if(groups.open){groups.open=false;$('trayGroupLabel').focus()}
  else void action('close');
});
$('trayExit').addEventListener('click',()=>void action('exit'));
installMarquee($('trayActiveName'));
refresh();
