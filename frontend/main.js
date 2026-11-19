import {filterServers,sortServers,latencyClass,SORT_COLUMNS} from './model.js';
import {parseImport,parseShareLink} from './config.js';
import {createRepository} from './store.js';
import {outboundFromShareLink} from './xray-config.js';
import {bytesPerSecond,pingPool} from './runtime.js';
import {readAppearance,applyAppearance} from './appearance.js';
import {STORAGE_KEY} from './store.js';
const $=id=>document.getElementById(id);
const KEY='simpleray.phase1.preferences.v1';
const safeLoad=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return {}}};
const pref=safeLoad();
let repo=createRepository(localStorage);
const appearance=readAppearance(localStorage);
const switching={
  mode:['off','suggest','automatic'].includes(pref.switchMode)?pref.switchMode:'off',
  source:typeof pref.switchSource==='string'?pref.switchSource:'favorites'
};
let lastSwitchConfig;
let configUpdate=Promise.resolve();
const state={servers:[],selected:null,sortKey:null,sortDirection:'asc',query:'',theme:appearance.mode,palette:appearance.palette,customPrimary:appearance.primary,customAccent:appearance.accent,pingSamples:pref.pingPreferenceVersion===2&&[1,2,3].includes(pref.pingSamples)?pref.pingSamples:pref.pingSamples===1?1:2,contextId:null,editingId:null,pendingSubscriptionUrls:[],updating:false,connection:{state:'disconnected',serverId:null,systemProxy:false,downloadBps:0,uploadBps:0,trafficAvailable:false},connectionBusy:false,pingBusy:false,pingAbort:false};
// Native desktop preferences belong to Rust so close-to-tray also works
// when the WebView is hidden. Browser-only preview keeps these disabled.
const desktop={minimizeToTray:true,autoConnect:false,startup:false,loading:false};
let toastTimeout;
let connectionPoll;
let connectionRevision=0;
let activePing;


function icon(name){
  return `<svg class="ui-icon" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
}

function initWindowChrome(){
  const windowArgs={label:'main'};
  const maximize=$('windowMaximize');
  document.querySelector('.window-actions').hidden=false;
  const syncMaximize=async()=>{
    const isMaximized=await nativeInvoke('plugin:window|is_maximized',windowArgs);
    const label=isMaximized?'Restore window':'Maximize';
    maximize.innerHTML=icon(isMaximized?'restore':'maximize');
    maximize.setAttribute('aria-label',label);
    maximize.title=label;
  };
  for(const [id,command] of [
    ['windowMinimize','minimize'],['windowMaximize','toggle_maximize'],['windowClose','close']
  ]){
    $(id).addEventListener('click',async()=>{
      try{
        await nativeInvoke(`plugin:window|${command}`,windowArgs);
        if(id==='windowMaximize')await syncMaximize();
      }catch(error){toast(errorMessage(error))}
    });
  }
  let frame;
  window.addEventListener('resize',()=>{
    cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>void syncMaximize().catch(()=>{}));
  });
  void nativeInvoke('plugin:app|version').then(version=>{
    $('appVersion').textContent=`v${version}`;
    $('appVersion').hidden=false;
  }).catch(()=>{});
}
function renderDesktopSettings(){
  for (const [id,checked] of [['trayToggle',desktop.minimizeToTray],['autoConnectToggle',desktop.autoConnect],['startupToggle',desktop.startup]]){
    const input=$(id);input.checked=Boolean(checked);input.disabled=!nativeHost()||desktop.loading;
    input.title=nativeHost()?'':'Available in the native Windows client';
  }
  $('startupStatus').textContent=desktop.startup?'On':'Off';
}
async function readDesktopSettings(){
  renderDesktopSettings();if(!nativeHost())return;
  desktop.loading=true;
  renderDesktopSettings();
  const [settings,startup]=await Promise.allSettled([nativeInvoke('get_desktop_settings'),nativeInvoke('get_autostart_enabled')]);
  if(settings.status==='fulfilled'){
    desktop.minimizeToTray=Boolean(settings.value.minimizeToTray);
    desktop.autoConnect=Boolean(settings.value.autoConnect);
  }else toast(errorMessage(settings.reason));
  if(startup.status==='fulfilled')desktop.startup=Boolean(startup.value);
  else toast(errorMessage(startup.reason));
  desktop.loading=false;
  renderDesktopSettings();
  if(desktop.autoConnect&&state.selected&&state.connection.state!=='connected')await connectSelected();
}
async function changeDesktopSetting(field,value){
  if(!nativeHost())return;
  const old=desktop[field]; desktop[field]=value;desktop.loading=true;renderDesktopSettings();
  try{
    if(field==='startup')desktop.startup=Boolean(await nativeInvoke('set_autostart_enabled',{enabled:value}));
    else{
      const next=await nativeInvoke('set_desktop_settings',{preferences:{minimizeToTray:desktop.minimizeToTray,autoConnect:desktop.autoConnect}});
      desktop.minimizeToTray=Boolean(next.minimizeToTray);desktop.autoConnect=Boolean(next.autoConnect);
    }
  }catch(err){desktop[field]=old;toast(errorMessage(err))}
  finally{desktop.loading=false;renderDesktopSettings()}
}

function persist(){try{localStorage.setItem(KEY,JSON.stringify({theme:state.theme,palette:state.palette,customPrimary:state.customPrimary,customAccent:state.customAccent,pingSamples:state.pingSamples,pingPreferenceVersion:2,switchMode:switching.mode,switchSource:switching.source}))}catch{toast('Unable to save preferences')}}
function toast(message){const el=$('toast');el.textContent=String(message);el.classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('visible'),3800)}
function errorMessage(e){return e instanceof Error?e.message:String(e||'Operation failed')}
function safeAction(fn){try{return fn()}catch(e){toast(errorMessage(e));return null}}
function resolvedTheme(){return state.theme==='system'?(window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark'):state.theme}
function applyTheme(){
 applyAppearance(document.documentElement,{mode:state.theme,palette:state.palette,primary:state.customPrimary,accent:state.customAccent},window.matchMedia?.('(prefers-color-scheme: light)').matches);
 $('appearanceModeSelect').value=state.theme;
 $('customPrimary').value=state.customPrimary;$('customAccent').value=state.customAccent;
 $('customColorRow').hidden=state.palette!=='custom';
 document.querySelectorAll('[data-palette-option]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.paletteOption===state.palette)));
}
function sync(){
  const db=repo.snapshot();
  state.servers=repo.rows();
  state.selected=db.selectedId;
  render();
  renderSubscriptionList();
  renderSwitchSettings(db.subscriptions);
  void updateSwitchConfig().catch(error=>toast(errorMessage(error)));
}
function renderSwitchSettings(subscriptions=repo.snapshot().subscriptions){
  $('switchMode').value=switching.mode;
  $('switchMode').disabled=!nativeHost();
  $('switchSourceRow').hidden=switching.mode==='off';
  const select=$('switchSource');
  select.replaceChildren(new window.Option('Favorites','favorites'));
  for(const sub of subscriptions)select.add(new window.Option(sub.name,`subscription:${sub.id}`));
  if(![...select.options].some(option=>option.value===switching.source)){
    select.add(new window.Option('Unavailable subscription',switching.source));
  }
  select.value=switching.source;
}
function updateSwitchConfig(){
  if(!nativeHost())return Promise.resolve();
  const candidates=[];
  if(switching.mode!=='off'){
    for(const server of state.servers){
      if(switching.source==='favorites'?!server.favorite:switching.source!==`subscription:${server.subscriptionId}`)continue;
      try{candidates.push({serverId:server.id,outbound:outboundFromShareLink(server.uri)})}catch{continue}
      if(candidates.length===5)break;
    }
  }
  const config={mode:switching.mode,candidates};
  const key=JSON.stringify(config);
  if(lastSwitchConfig===key)return configUpdate;
  lastSwitchConfig=key;
  configUpdate=configUpdate.catch(()=>{}).then(()=>nativeInvoke('configure_server_switching',config)).catch(error=>{
    if(lastSwitchConfig===key)lastSwitchConfig=undefined;
    throw error;
  });
  return configUpdate;
}
function getSelected(){return state.servers.find(s=>s.id===state.selected)||null}
function serverRow(id){return $('serverRows').querySelector(`[data-id="${CSS.escape(String(id))}"]`)}
function setSelected(id){
  if(id===state.selected||!safeAction(()=>repo.setSelected(id)))return;
  const previous=serverRow(state.selected);
  previous?.classList.remove('selected');
  previous?.setAttribute('aria-selected','false');
  state.selected=id;
  const selected=serverRow(id);
  selected?.classList.add('selected');
  selected?.setAttribute('aria-selected','true');
  renderConnection();
}
function nativeHost(){return Boolean(window.__TAURI_INTERNALS__?.invoke)}
function renderConnection(){
  const c=state.connection;
  const connected=c.state==='connected';
  const health=c.health;
  const session=connected||health?.recovering;
  const active=session?state.servers.find(s=>s.id===c.serverId)||null:null;
  const server=session?active:getSelected();
  const disabled=!nativeHost()||state.connectionBusy||(!session&&!server);
  $('connectionSwitch').disabled=Boolean(disabled);
  $('connectionSwitch').setAttribute('aria-checked',String(Boolean(session)));
  $('connectionSwitch').setAttribute('aria-label',session?'Disconnect':'Connect');
  const unhealthy=(health?.consecutiveFailures??0)>=2;
  const status=state.connectionBusy||(unhealthy&&session?'Server not responding':connected?'Connected':'Disconnected');
  $('connectionState').textContent=status;
  $('stateLed').title=state.connectionBusy||status;
  $('stateLed').classList.toggle('proxy-off',connected&&(!c.systemProxy||unhealthy));
  $('selectedText').textContent=server?`${server.name} · ${server.type}`:session?'Current connection':'No server selected';
  const ms=session?(health?.attempts?health.latencyMs:c.initialLatencyMs):server?.latency;
  const pinging=connected&&activePing?.revision===connectionRevision;
  const failed=session&&health?.attempts&&!Number.isFinite(ms);
  $('latencyLabel').textContent=session?'Live latency':'Latency';
  const latencyText=pinging?'Testing…':failed?'No reply':Number.isFinite(ms)?`${ms} ms`:'—';
  if($('selectedLatency').textContent!==latencyText)$('selectedLatency').textContent=latencyText;
  $('selectedLatency').className=failed?'live-ping-failed':latencyClass(ms);
  const stability=$('connectionStability');
  stability.hidden=!session||!health?.attempts;
  if(!stability.hidden){
    const seconds=health.measuredAtMs?Math.max(0,Math.floor((Date.now()-health.measuredAtMs)/1000)):null;
    stability.textContent=`${health.successes}/${health.attempts} answered${seconds===null?'':` · ${seconds}s ago`}`;
  }
  $('activePingButton').hidden=!connected;
  $('activePingButton').disabled=Boolean(pinging||state.connectionBusy);
  $('activePingButton').setAttribute('aria-busy',String(pinging));
  $('traffic').hidden=!connected;
  $('downRate').textContent=c.trafficAvailable?bytesPerSecond(c.downloadBps):'—';
  $('upRate').textContent=c.trafficAvailable?bytesPerSecond(c.uploadBps):'—';
  $('connectionSwitch').closest('.connection-panel').classList.toggle('no-servers',!server);
  $('connectionSwitch').closest('.connection-panel').classList.toggle('preview-on',connected&&!unhealthy&&c.systemProxy);
  $('connectionSwitch').closest('.connection-panel').classList.toggle('connecting',Boolean(state.connectionBusy));
  $('footerConnection').lastChild.textContent=` ${status}`;
  $('systemProxyStatus').textContent=session?(c.systemProxy?'Active':'Off'):'Auto with connection';
  $('systemProxyStatus').dataset.state=session?(c.systemProxy?'active':'off'):'automatic';
  $('repairProxyButton').hidden=!connected||c.systemProxy;
  $('repairProxyButton').disabled=Boolean(state.connectionBusy);
  renderSwitchNotice(session?health:null);
}
function renderSwitchNotice(health){
  const suggestion=switching.mode==='suggest'?health?.suggestion:null;
  const switched=health?.switched;
  const decision=suggestion??switched;
  const server=decision&&state.servers.find(item=>item.id===decision.serverId);
  const name=server?.name??'the selected server';
  let message='';
  if(decision){
    const title=switched?`Switched to ${name}`:`Try ${name}`;
    const reason=decision.reason==='recovery'?'current server did not respond':
      `${decision.previousMs-decision.candidateMs} ms faster`;
    message=`${title} · ${reason}`;
  }else if(health?.switching)message='Verifying new connection…';
  else if(health?.checking)message='Checking selected servers…';
  else if(health?.waiting)message='No usable switch yet. Trying again after a pause.';
  else if(health?.noCandidates)message='Select favorites or a subscription with another server to switch.';
  $('switchNotice').hidden=!message;
  if($('switchMessage').textContent!==message)$('switchMessage').textContent=message;
  const apply=$('applySuggestion');
  apply.hidden=!suggestion;
  apply.disabled=Boolean(state.connectionBusy);
  const undo=$('undoSwitch');
  undo.hidden=!health?.canUndo;
  undo.disabled=Boolean(state.connectionBusy);
}
function applyConnectionStatus(current){
  const previous=state.connection;
  state.connection=current;
  if(current.state==='connected'&&current.serverId!==previous.serverId&&current.health?.switched){
    setSelected(current.serverId);
  }
  if(current.error&&current.error!==previous.error)toast(current.error);
}

async function refreshConnectionStatus({silent=false}={}){
  if(!nativeHost()||state.connectionBusy||connectionPoll)return;
  const revision=connectionRevision;
  try{
    connectionPoll=nativeInvoke('connection_status');
    const current=await connectionPoll;
    if(revision!==connectionRevision)return;
    applyConnectionStatus(current);
    renderConnection();
  }catch(err){if(!silent&&revision===connectionRevision)toast(errorMessage(err));}
  finally{connectionPoll=null}
}
async function connectSelected(id=state.selected){
  if(!nativeHost()){toast('Connections require the native Windows desktop app');return}
  const server=state.servers.find(s=>s.id===id);
  if(!server){toast('Select a server before connecting');return}
  if(state.connectionBusy)return;
  if(state.connection.state==='connected'&&state.connection.serverId===id)return;
  connectionRevision++;
  state.connectionBusy=state.connection.state==='connected'?'Switching…':'Connecting…';renderConnection();
  try{
    const outbound=outboundFromShareLink(server.uri);
    state.connection=await nativeInvoke('connect_server',{serverId:id,outbound});
    toast('Connected · Windows System Proxy is active');
  }catch(err){toast(errorMessage(err))}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}
async function disconnectConnection(){
  if(!nativeHost()||state.connectionBusy)return;
  connectionRevision++;
  state.connectionBusy='Disconnecting…';renderConnection();
  try{state.connection=await nativeInvoke('disconnect_server');toast('Disconnected');}
  catch(err){toast(errorMessage(err))}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}
async function toggleConnection(){
  if(state.connection.state==='connected'||state.connection.health?.recovering)await disconnectConnection();
  else await connectSelected();
}
async function restoreSystemProxy(){
  if(state.connectionBusy||state.connection.state!=='connected')return;
  connectionRevision++;
  state.connectionBusy='Restoring proxy…';
  renderConnection();
  try{
    state.connection=await nativeInvoke('restore_system_proxy');
    toast('Windows System Proxy restored');
  }catch(error){toast(errorMessage(error))}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}
async function testActiveConnection(){
  if(state.connection.state!=='connected'||state.connectionBusy||activePing?.revision===connectionRevision)return;
  const request={serverId:state.connection.serverId,revision:connectionRevision};
  activePing=request;
  renderConnection();
  try{
    await nativeInvoke('ping_active_connection',{serverId:request.serverId});
  }catch(error){
    if(request.revision===connectionRevision&&state.connection.serverId===request.serverId
      && errorMessage(error)==='Live latency test already running')toast(errorMessage(error));
  }finally{
    if(activePing===request)activePing=null;
    renderConnection();
    await refreshConnectionStatus({silent:true});
  }
}
async function respondToSwitch(undo){
  if(state.connectionBusy)return;
  const suggestion=state.connection.health?.suggestion;
  if(undo?!state.connection.health?.canUndo:!suggestion)return;
  connectionRevision++;
  state.connectionBusy=undo?'Returning…':'Switching…';
  renderConnection();
  try{
    state.connection=await (undo?nativeInvoke('undo_server_switch'):
      nativeInvoke('accept_server_suggestion',{serverId:suggestion.serverId}));
    setSelected(state.connection.serverId);
  }catch(error){toast(errorMessage(error))}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}

async function pingServers(servers,samples){
  if(!nativeHost()){toast('Real latency testing requires the native app and Xray-core');return}
  if(state.pingBusy){toast('A latency test is already running');return}
  if(!servers.length){toast('No configurations to test');return}
  state.pingBusy=true;state.pingAbort=false;
  const button=$('pingAllButton');
  button.setAttribute('aria-busy','true');button.innerHTML=`${icon('close')} <span>Cancel ping</span>`;
  try{
    const summary=await pingPool(servers,samples,
      async server=>nativeInvoke('measure_server_latency',{outbound:outboundFromShareLink(server.uri),samples}),
      (server,result,done,total)=>{
        // A subscription refresh may have removed this entry while probing.
        if(state.servers.some(s=>s.id===server.id&&s.signature===server.signature)){
          safeAction(()=>repo.setLatency(server.id,result));
          state.servers=repo.rows();
          render();
        }
        $('runtimeNotice').textContent=`Latency tested: ${done}/${total} · ${samples} probe${samples===1?'':'s'} per server`;
      },{concurrency:3,shouldStop:()=>state.pingAbort});
    toast(`Real-delay tests ${summary.cancelled?'cancelled':'completed'}: ${summary.finished}/${summary.total}`);
  }catch(err){toast(errorMessage(err))}
  finally{state.pingBusy=false;state.pingAbort=false;button.removeAttribute('aria-busy');button.innerHTML=`${icon('activity')} <span>Ping <span class="muted-sub">All</span></span>`;}
}

function renderSort(){for(const btn of document.querySelectorAll('[data-sort]')){const active=btn.dataset.sort===state.sortKey;btn.dataset.active=String(active);btn.querySelector('.sort-indicator').innerHTML=icon(active?(state.sortDirection==='asc'?'up':'down'):'sort');btn.setAttribute('aria-sort',active?(state.sortDirection==='asc'?'ascending':'descending'):'none')}}
function orderedRows(){const rows=filterServers(state.servers,state.query);return state.sortKey?sortServers(rows,state.sortKey,state.sortDirection):rows}
function renderTable(){const rows=orderedRows(),body=$('serverRows');const focused=body.contains(document.activeElement)?document.activeElement:null;const focusedId=focused?.closest('tr')?.dataset.id;body.replaceChildren();for(const s of rows){const tr=document.createElement('tr');tr.dataset.id=s.id;tr.classList.toggle('selected',s.id===state.selected);tr.tabIndex=0;tr.setAttribute('aria-selected',String(s.id===state.selected));
    const starCell=tr.insertCell();const star=document.createElement('button');star.className='star'+(s.favorite?' is-favorite':'');star.innerHTML=icon('star');star.title=s.favorite?'Remove favorite':'Add favorite';star.setAttribute('aria-label',`${s.favorite?'Unstar':'Star'} ${s.name}`);star.addEventListener('click',e=>{e.stopPropagation();toggleFavorite(s.id)});starCell.append(star);
    const nameCell=tr.insertCell();const wrap=document.createElement('div');wrap.className='name-cell';const flag=document.createElement('span');flag.className='flag';if(s.flag&&s.flag!=='🌐')flag.textContent=s.flag;else flag.innerHTML=icon('globe');const name=document.createElement('span');name.className='server-name';name.textContent=s.name;wrap.append(flag,name);nameCell.append(wrap);
    const typeCell=tr.insertCell();const type=document.createElement('span');type.className='type-label type-'+s.type.toLowerCase();type.textContent=s.type;typeCell.append(type);
    const latencyCell=tr.insertCell();const latency=document.createElement('span');latency.className='latency-text '+latencyClass(s.latency);latency.textContent=typeof s.latency==='number'?`${s.latency}`:s.latencyStatus==='timeout'?'Timeout':s.latencyStatus==='error'?'Failed':'—';latency.title=s.latencyAttempted?`${s.latencySuccess||0}/${s.latencyAttempted} successful real-delay probes`: 'Not measured';latencyCell.append(latency);
    const sourceCell=tr.insertCell();sourceCell.className='source-cell';sourceCell.textContent=s.source;
    tr.addEventListener('click',()=>setSelected(s.id));tr.addEventListener('dblclick',()=>{setSelected(s.id);void connectSelected(s.id)});
    tr.addEventListener('contextmenu',e=>{e.preventDefault();setSelected(s.id);showContextMenu(s.id,e.clientX,e.clientY)});
    tr.addEventListener('keydown',e=>{if(e.target!==tr)return;if(e.key==='Enter'){e.preventDefault();setSelected(s.id);void connectSelected(s.id)}if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();setSelected(s.id);const rect=tr.getBoundingClientRect();showContextMenu(s.id,rect.left+150,rect.top+30)}});body.append(tr)}
  if(focusedId){const row=serverRow(focusedId);const control=focused.matches('.star')?row?.querySelector('.star'):row;control?.focus({preventScroll:true})}
  $('emptyMessage').hidden=rows.length!==0;$('sampleCount').textContent=`${rows.length} of ${state.servers.length} configurations`;renderSort();renderConnection()}
function render(){renderTable()}
function toggleFavorite(id){if(safeAction(()=>repo.toggleFavorite(id)))sync()}
function closeContextMenu(){$('contextMenu').hidden=true;state.contextId=null}
function addMenuButton(parent,iconName,label,action,{disabled=false,danger=false}={}){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.className='menu-button'+(danger?' menu-danger':'');button.disabled=disabled;const iconSpan=document.createElement('span');iconSpan.className='menu-icon';iconSpan.innerHTML=icon(iconName);const txt=document.createElement('span');txt.textContent=label;button.append(iconSpan,txt);if(!disabled)button.addEventListener('click',()=>{closeContextMenu();action()});parent.append(button);return button}
function showContextMenu(id,x,y){const s=state.servers.find(s=>s.id===id);if(!s)return;state.contextId=id;const menu=$('contextMenu');menu.replaceChildren();addMenuButton(menu,'play','Connect / Select',()=>{setSelected(id);void connectSelected(id)});addMenuButton(menu,'activity','Ping (×1)',()=>void pingServers([s],1));addMenuButton(menu,'activity','Ping (×2) — Average',()=>void pingServers([s],2));addMenuButton(menu,'activity','Ping (×3) — Average',()=>void pingServers([s],3));const div=document.createElement('div');div.className='menu-divider';menu.append(div);addMenuButton(menu,'star',s.favorite?'Remove Favorite':'Set as Favorite',()=>toggleFavorite(id));addMenuButton(menu,'edit',s.subscriptionId?'Edit (subscription-managed)':'Edit',()=>openManualDialog(id),{disabled:Boolean(s.subscriptionId)});addMenuButton(menu,'copy','Duplicate as manual',()=>{if(safeAction(()=>repo.duplicateManual(id)))sync()});addMenuButton(menu,'delete','Delete',()=>removeServer(id),{danger:true});if(s.subscriptionId){const note=document.createElement('div');note.className='menu-note';note.textContent='Deleting this subscription node hides it from future refreshes';menu.append(note)}menu.hidden=false;menu.style.left='0px';menu.style.top='0px';const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-bounds.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-bounds.height-8))}px`}
function closePasteMenu(){$('pasteMenu').hidden=true;$('pasteMenuButton').setAttribute('aria-expanded','false')}
function showDialog(id){const target=$(id);for(const dialog of document.querySelectorAll('dialog[open]')){if(dialog!==target)dialog.close()}if(!target.open)target.showModal()}
function confirmAction(title,description,acceptLabel='Delete',keepLabel=null){return new Promise(resolve=>{const dialog=$('confirmDialog');$('confirmTitle').textContent=title;$('confirmDescription').textContent=description;$('confirmAccept').textContent=acceptLabel;$('confirmKeep').hidden=!keepLabel;if(keepLabel)$('confirmKeep').textContent=keepLabel;let done=false;const finish=result=>{if(done)return;done=true;dialog.close();dialog.removeEventListener('close',cancel);$('confirmCancel').removeEventListener('click',onCancel);$('confirmClose').removeEventListener('click',onCancel);$('confirmAccept').removeEventListener('click',onYes);$('confirmKeep').removeEventListener('click',onKeep);resolve(result)};const cancel=()=>finish(false),onCancel=()=>finish(false),onYes=()=>finish(true),onKeep=()=>finish('keep');dialog.addEventListener('close',cancel);$('confirmCancel').addEventListener('click',onCancel);$('confirmClose').addEventListener('click',onCancel);$('confirmAccept').addEventListener('click',onYes);$('confirmKeep').addEventListener('click',onKeep);showDialog('confirmDialog')})}
async function removeServer(id){const s=state.servers.find(x=>x.id===id);if(!s)return;const answer=await confirmAction('Delete configuration?',s.subscriptionId?'This node will be hidden on future subscription updates.':'This manual configuration will be removed from local storage.');if(!answer)return;if(state.connection.state==='connected'&&state.connection.serverId===id){await disconnectConnection();if(state.connection.state==='connected')return}if(safeAction(()=>repo.deleteServer(id)))sync()}
function openManualDialog(id=null){closePasteMenu();$('manualError').textContent='';state.editingId=id;const s=state.servers.find(x=>x.id===id);$('manualDialogTitle').textContent=s?'Edit configuration':'Add server';$('manualUri').value=s?.uri||'';$('manualName').value=s?.name||'';showDialog('manualDialog');$('manualUri').focus()}
function openSubscriptionDialog(url=''){closePasteMenu();$('subscriptionError').textContent='';$('subscriptionName').value='';$('subscriptionUrl').value=url;showDialog('subscriptionDialog');$('subscriptionName').focus()}
function openManager(){closePasteMenu();renderSubscriptionList();showDialog('manageDialog')}
function sourceName(sub){return sub.name}
function renderSubscriptionList(){const list=$('subscriptionList');list.replaceChildren();const subscriptions=repo.snapshot().subscriptions;if(!subscriptions.length){const text=document.createElement('p');text.className='manager-empty';text.textContent='No subscriptions yet. Add one by name and URL.';list.append(text);return}for(const sub of subscriptions){const item=document.createElement('div');item.className='subscription-card';const meta=document.createElement('div');meta.className='subscription-meta';const title=document.createElement('strong');title.textContent=sourceName(sub);const info=document.createElement('p');info.textContent=`${state.servers.filter(s=>s.subscriptionId===sub.id).length} servers · ${sub.updatedAt?new Date(sub.updatedAt).toLocaleString():'Not updated yet'}`;meta.append(title,info);if(sub.lastError){const error=document.createElement('p');error.className='sub-error';error.textContent=sub.lastError;meta.append(error)}const controls=document.createElement('div');controls.className='subscription-actions';for(const [text,action,cls] of [['Update',()=>updateSubscription(sub.id),''],['Rename',()=>renameSubscription(item,sub),''],['Delete',()=>removeSubscription(sub.id),'delete-sub']]){const b=document.createElement('button');b.textContent=text;b.className=cls;b.disabled=state.updating;b.addEventListener('click',action);controls.append(b)}item.append(meta,controls);list.append(item)}}
function renameSubscription(item,sub){const meta=item.querySelector('.subscription-meta');meta.replaceChildren();const input=document.createElement('input');input.value=sub.name;input.maxLength=160;input.setAttribute('aria-label','New subscription name');meta.append(input);const controls=item.querySelector('.subscription-actions');controls.replaceChildren();const save=document.createElement('button');save.textContent='Save';save.addEventListener('click',()=>{if(safeAction(()=>repo.renameSubscription(sub.id,input.value)))sync()});const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.addEventListener('click',renderSubscriptionList);controls.append(save,cancel);input.focus();input.select();input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save.click()}else if(e.key==='Escape'){e.preventDefault();renderSubscriptionList()}})}
async function removeSubscription(id){
  const sub=repo.snapshot().subscriptions.find(x=>x.id===id);
  if(!sub)return;
  const choice=await confirmAction('Delete subscription?',`Remove “${sub.name}”. Keep its imported servers as standalone configurations, or delete them too?`, 'Delete all', 'Keep servers');
  if(!choice)return;
  const active=state.servers.find(server=>server.id===state.connection.serverId);
  if(choice!=='keep'&&active?.subscriptionId===id){
    await disconnectConnection();
    if(state.connection.state==='connected')return;
  }
  if(safeAction(()=>repo.deleteSubscription(id,{keepNodes:choice==='keep'})))sync();
}
async function nativeInvoke(command,args){if(!window.__TAURI_INTERNALS__?.invoke)throw new Error('Native commands are available only in the installed desktop app');return window.__TAURI_INTERNALS__.invoke(command,args)}
async function readClipboardText(){if(window.__TAURI_INTERNALS__?.invoke)return nativeInvoke('read_clipboard_text');if(navigator.clipboard?.readText)return navigator.clipboard.readText();throw new Error('Clipboard API unavailable; use Paste menu → Add manual configuration')}
async function fetchSubscription(url){if(window.__TAURI_INTERNALS__?.invoke)return nativeInvoke('fetch_subscription_text',{url});
  // Browser-only development preview. The desktop backend bypasses browser CORS safely.
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),20000);
  try{const response=await fetch(url,{signal:controller.signal,redirect:'follow'});if(!response.ok)throw new Error(`HTTP ${response.status}`);if(Number(response.headers.get('content-length'))>2_000_000)throw new Error('Subscription is too large');const result=await response.text();if(result.length>2_000_000)throw new Error('Subscription is too large');return result}
  catch{throw new Error('Subscription download failed. Browser previews may be blocked by CORS; use the desktop app.')}
  finally{clearTimeout(timer)}}
async function updateSubscription(id){const sub=repo.snapshot().subscriptions.find(s=>s.id===id);if(!sub||state.updating)return null;state.updating=true;renderSubscriptionList();toast(`Updating “${sub.name}”…`);try{const response=await fetchSubscription(sub.url);const stats=repo.refreshSubscription(id,response);sync();toast(`Updated “${sub.name}”: ${stats.added} added, ${stats.retained} retained, ${stats.removed} removed${stats.invalid?`, ${stats.invalid} skipped`:''}`);return stats}
  catch(e){const reason=errorMessage(e);safeAction(()=>repo.setSubscriptionError(id,reason));toast(`${sub.name}: ${reason}`);return null}
  finally{state.updating=false;sync()}}
async function updateAll(){const subscriptions=repo.snapshot().subscriptions;if(!subscriptions.length){toast('No subscriptions to update. Add a subscription first.');return}if(state.updating)return;let ok=0;for(const sub of subscriptions){const result=await updateSubscription(sub.id);if(result)ok++}toast(`Subscription update complete: ${ok}/${subscriptions.length} succeeded`)}
async function submitSubscription(){const name=$('subscriptionName').value,url=$('subscriptionUrl').value;let created;try{created=repo.addSubscription(name,url)}catch(e){$('subscriptionError').textContent=errorMessage(e);return}sync();$('subscriptionDialog').close();await updateSubscription(created.id);if(state.pendingSubscriptionUrls.length)openSubscriptionDialog(state.pendingSubscriptionUrls.shift())}
async function importClipboard(){let text;try{text=await readClipboardText()}catch(e){toast(errorMessage(e));openManualDialog();return}if(!text?.trim()){toast('Clipboard is empty');return}
  const before=repo.rows().length;let result;try{result=repo.importManual(text)}catch(e){toast(errorMessage(e));return}sync();if(result.servers.length)toast(`Added ${repo.rows().length-before} new configuration(s)${result.errors.length?`; ${result.errors.length} unsupported/invalid`:''}`);else if(result.errors.length)toast(`Could not import: ${result.errors[0].reason}`);
  if(result.subscriptionUrls.length){state.pendingSubscriptionUrls=result.subscriptionUrls.slice(1);openSubscriptionDialog(result.subscriptionUrls[0])}
}
function init(){if(nativeHost())document.documentElement.classList.add('native-host');applyTheme();$('pingSamples').value=String(state.pingSamples);sync();if(repo.loadError)toast(repo.loadError);
  if(!nativeHost()){$('phaseStatus').textContent='Browser preview';$('runtimeNotice').textContent='Real connection and Ping require the Windows desktop host';}
  else{initWindowChrome();void refreshConnectionStatus({silent:true}).then(()=>configUpdate.catch(()=>{})).then(()=>readDesktopSettings());setInterval(()=>void refreshConnectionStatus({silent:true}),1500)}
  renderDesktopSettings();
  window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change',()=>{if(state.theme==='system')applyTheme()});
  document.querySelectorAll('[data-sort]').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.sort;if(!SORT_COLUMNS.includes(key))return;if(key===state.sortKey)state.sortDirection=state.sortDirection==='asc'?'desc':'asc';else{state.sortKey=key;state.sortDirection=key==='favorite'?'desc':'asc'}render()}));
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value;render()});
  $('connectionSwitch').addEventListener('click',()=>void toggleConnection());
  $('activePingButton').addEventListener('click',()=>void testActiveConnection());
  $('repairProxyButton').addEventListener('click',()=>void restoreSystemProxy());
  $('applySuggestion').addEventListener('click',()=>void respondToSwitch(false));
  $('undoSwitch').addEventListener('click',()=>void respondToSwitch(true));
  for(const [id,field] of [['switchMode','mode'],['switchSource','source']]){
    $(id).addEventListener('change',event=>{
      switching[field]=event.target.value;
      persist();
      renderSwitchSettings();
      renderConnection();
      void updateSwitchConfig().catch(error=>toast(errorMessage(error)));
    });
  }
  $('selectedServer').addEventListener('click',()=>{const row=serverRow(state.connection.serverId??state.selected);row?.scrollIntoView({block:'nearest',behavior:'smooth'});row?.focus()});
  $('pasteButton').addEventListener('click',importClipboard);
  $('pasteMenuButton').addEventListener('click',()=>{const menu=$('pasteMenu');menu.hidden=!menu.hidden;$('pasteMenuButton').setAttribute('aria-expanded',String(!menu.hidden))});
  $('manualAddButton').addEventListener('click',()=>openManualDialog());
  $('subscriptionAddButton').addEventListener('click',()=>openSubscriptionDialog());
  $('subscriptionManageButton').addEventListener('click',openManager);
  $('settingsSubscriptions').addEventListener('click',openManager);
  $('managerAddButton').addEventListener('click',()=>openSubscriptionDialog());
  $('manualForm').addEventListener('submit',e=>{e.preventDefault();const uri=$('manualUri').value,name=$('manualName').value;try{if(state.editingId)repo.updateManual(state.editingId,uri,name);else repo.addManual({uri,name});$('manualDialog').close();sync();toast('Configuration saved locally')}catch(err){$('manualError').textContent=errorMessage(err)}});
  $('subscriptionForm').addEventListener('submit',e=>{e.preventDefault();void submitSubscription()});
  $('updateButton').addEventListener('click',()=>void updateAll());
  $('pingAllButton').addEventListener('click',()=>{
    if(state.pingBusy){state.pingAbort=true;toast('Cancelling queued tests; active probes will finish')}
    else void pingServers(state.servers,state.pingSamples);
  });
  $('settingsButton').addEventListener('click',()=>showDialog('settingsDialog'));
  $('startupToggle').addEventListener('change',e=>void changeDesktopSetting('startup',e.target.checked));
  $('trayToggle').addEventListener('change',e=>void changeDesktopSetting('minimizeToTray',e.target.checked));
  $('autoConnectToggle').addEventListener('change',e=>void changeDesktopSetting('autoConnect',e.target.checked));
  window.addEventListener('simpleray:tray-toggle',()=>void toggleConnection());
  window.addEventListener('simpleray:exit-blocked',()=>toast('Cannot exit safely: System Proxy restoration failed. Restore Windows proxy settings before forcing exit.'));
  $('settingsClose').addEventListener('click',()=>$('settingsDialog').close());
  for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close());
  $('appearanceModeSelect').addEventListener('change',e=>{state.theme=e.target.value;applyTheme();persist()});
  document.querySelectorAll('[data-palette-option]').forEach(button=>button.addEventListener('click',()=>{state.palette=button.dataset.paletteOption;applyTheme();persist()}));
  for(const id of ['customPrimary','customAccent'])$(id).addEventListener('input',e=>{state[id]=e.target.value;applyTheme();persist()});
  $('pingSamples').addEventListener('change',e=>{state.pingSamples=[1,2,3].includes(Number(e.target.value))?Number(e.target.value):2;persist();toast(`Ping All: ${state.pingSamples} real-delay probe${state.pingSamples===1?'':'s'} per server`)});
  window.addEventListener('simpleray:quick-server-change',()=>{repo=createRepository(localStorage);sync();void refreshConnectionStatus({silent:true})});
  window.addEventListener('storage',e=>{if(e.key===STORAGE_KEY){repo=createRepository(localStorage);sync();void refreshConnectionStatus({silent:true})}if(e.key===KEY){const a=readAppearance(localStorage);Object.assign(state,{theme:a.mode,palette:a.palette,customPrimary:a.primary,customAccent:a.accent});applyTheme()}});
  document.addEventListener('click',e=>{if(!e.target.closest('#contextMenu'))closeContextMenu();if(!e.target.closest('.paste-group'))closePasteMenu()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeContextMenu();closePasteMenu()}});
  window.addEventListener('resize',closeContextMenu);
}
init();
