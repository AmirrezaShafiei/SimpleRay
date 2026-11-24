import {filterServers,sortServers,latencyClass,stabilityLevel,SORT_COLUMNS} from './model.js';
import {parseImport,parseShareLink} from './config.js';
import {createRepository} from './store.js';
import {outboundFromShareLink} from './xray-config.js';
import {bytesPerSecond,DEFAULT_PING_SAMPLES,formatBytes,latencyResponseCount,
  MAX_SPEED_SERVERS,normalizedLatencyResult,pingPool,SPEED_SAMPLE_MB,speedCandidates} from './runtime.js';
import {displayServerName,renderFlag} from './flags.js';
import {phoneTransferControls} from './phone-transfer.js';
import {attachColorWheel} from './color-wheel.js';
import {createRoutingEditor, renderIpHistory} from './routing.js';
import {APPEARANCE_KEY,THEME_COLORS,paintAppearance,restoreAppearance,savedPreferences,themeColor} from './theme.js';
const $=id=>document.getElementById(id);
const pref=savedPreferences(localStorage);
const repo=createRepository(localStorage);
const MAX_SWITCH_CANDIDATES = 6;
const switching={
  mode:['off','suggest','automatic'].includes(pref.switchMode)?pref.switchMode:'off',
  source:typeof pref.switchSource==='string'?pref.switchSource:'favorites'
};
let lastSwitchConfig;
let configUpdate=Promise.resolve();
const SUBSCRIPTION_CHECK_INTERVAL = 60_000;
const state={servers:[],selected:null,sortKey:null,sortDirection:'asc',query:'',...restoreAppearance(pref),pingSamples:[1,2,3].includes(pref.pingSamples)?pref.pingSamples:DEFAULT_PING_SAMPLES,contextId:null,editingId:null,editingSubscriptionId:null,subscriptionFilterId:null,pendingSubscriptionUrls:[],updating:false,connection:{state:'disconnected',serverId:null,systemProxy:false,downloadBps:0,uploadBps:0,trafficAvailable:false},connectionBusy:false};
// Native desktop preferences belong to Rust so close-to-tray also works
// when the WebView is hidden. Browser-only preview keeps these disabled.
const desktop={minimizeToTray:true,autoConnect:false,startup:false,loading:false};
let toastTimeout;
let connectionPoll;
let connectionRevision=0;
let activePing;
let editNameId;
let colorWheel;
let routingEditor;
let serverTest;
const pingFeedback = new Map();
const downloadResults = new Map();
const speedNumber = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2});
const trayPanel={visible:false,lastSnapshot:'',lastServer:null,mode:'systemProxy',error:''};


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

function persist(){try{localStorage.setItem(APPEARANCE_KEY,JSON.stringify({palette:state.palette,appearance:state.appearance,themePrimary:state.themePrimary,themeAccent:state.themeAccent,pingSamples:state.pingSamples,switchMode:switching.mode,switchSource:switching.source}))}catch{toast('Unable to save preferences')}}
function toast(message){const el=$('toast');el.textContent=String(message);el.classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('visible'),3800)}
function errorMessage(e){return e instanceof Error?e.message:String(e||'Operation failed')}
function safeAction(fn){try{return fn()}catch(e){toast(errorMessage(e));return null}}
function applyTheme(){
  paintAppearance(document.documentElement,state,window.matchMedia?.('(prefers-color-scheme: light)')?.matches);
  for(const input of document.querySelectorAll('input[name="palette"], input[name="appearance"]')){
    input.checked=input.value===state[input.name];
  }
  $('themeColors').hidden=state.palette!=='custom';
  $('primaryColor').value=state.themePrimary;
  $('accentColor').value=state.themeAccent;
  if(state.palette==='custom')colorWheel?.refresh();
  syncTrayPanel();
}
function sync(){
  const db=repo.snapshot();
  state.servers=repo.rows();
  state.selected=db.selectedId;
  renderSubscriptionFilter(db.subscriptions);
  render();
  renderSubscriptionList(db.subscriptions);
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
      try{candidates.push({serverId:server.id,displayName:displayServerName(server),outbound:outboundFromShareLink(server.uri)})}catch{continue}
      // Include one extra profile in case the active server is among the candidates.
      if(candidates.length===MAX_SWITCH_CANDIDATES+1)break;
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
  if(nativeHost())void nativeInvoke("cancel_network_recovery").catch(()=>{});
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
  const usingTun=c.connectionMode==='tun';
  const routeActive=usingTun||c.systemProxy;
  $('connectionSwitch').disabled=Boolean(disabled);
  $('connectionSwitch').setAttribute('aria-checked',String(Boolean(session)));
  $('connectionSwitch').setAttribute('aria-label',session?'Disconnect':'Connect');
  const unhealthy=(health?.consecutiveFailures??0)>=2;
  const status=state.connectionBusy||(unhealthy&&session?'Server not responding':connected?'Connected':'Disconnected');
  $('connectionState').textContent=status;
  $('stateLed').title=state.connectionBusy||status;
  $('stateLed').classList.toggle('proxy-off',connected&&(!routeActive||unhealthy));
  renderFlag($('selectedFlag'),server,icon('globe'));
  $('selectedText').textContent=server?`${displayServerName(server)} · ${server.type}`:session?'Current connection':'No server selected';
  const ms=session?(health?.attempts?health.latencyMs:c.initialLatencyMs):latencyView(server)?.latency;
  const pinging=connected&&activePing?.revision===connectionRevision;
  const failed=session&&health?.attempts&&!Number.isFinite(ms);
  $('latencyLabel').textContent=session?'Live latency':'Latency';
  const latencyText=pinging?'Testing…':failed?'No reply':Number.isFinite(ms)?`${ms} ms`:'—';
  if($('selectedLatency').textContent!==latencyText)$('selectedLatency').textContent=latencyText;
  $('selectedLatency').className=failed?'live-ping-failed':latencyClass(ms);
  const stability=$('connectionStability');
  stability.hidden=!session||!health?.attempts;
  stability.dataset.level=stabilityLevel(health?.successes,health?.attempts);
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
  for(const [element,total] of [['downTotal',c.downloadBytes],['upTotal',c.uploadBytes]]){
    $(element).textContent=Number.isFinite(total)?`${formatBytes(total)} total`:'—';
  }
  $('connectionSwitch').closest('.connection-panel').classList.toggle('no-servers',!server);
  $('connectionSwitch').closest('.connection-panel').classList.toggle('preview-on',connected&&!unhealthy&&routeActive);
  $('connectionSwitch').closest('.connection-panel').classList.toggle('connecting',Boolean(state.connectionBusy));
  $('footerConnection').lastChild.textContent=` ${status}`;
  $('systemProxyStatus').textContent=session?(usingTun?'TUN':c.systemProxy?'System Proxy':'Off'):'Auto with connection';
  $('systemProxyStatus').dataset.state=session?(routeActive?'active':'off'):'automatic';
  $('repairProxyButton').hidden=!connected||routeActive;
  $('ipHistoryButton').hidden=!nativeHost()||!server;
  $('repairProxyButton').disabled=Boolean(state.connectionBusy);
  renderSwitchNotice(session?health:null);
  syncTrayPanel();
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
function trayConnectTarget(){
  return state.servers.some(server=>server.id===trayPanel.lastServer)?trayPanel.lastServer:state.selected;
}

function syncTrayPanel(force=false){
  if(!trayPanel.visible)return;
  const current=state.connection;
  if(current.state==='connected'&&current.serverId)trayPanel.lastServer=current.serverId;
  const activeId=current.serverId;
  const hasSession=Boolean(activeId&&(current.state==='connected'||current.health?.recovering||current.outageSeconds!=null));
  const snapshot={
    appearance:restoreAppearance(state),
    serverId:hasSession?activeId:trayConnectTarget(),
    activeId:hasSession?activeId:null,
    connectionMode:hasSession?current.connectionMode:trayPanel.mode,
    connected:current.state==='connected',
    proxyInactive:current.state==='connected'&&current.connectionMode==='systemProxy'&&!current.systemProxy,
    retry:hasSession&&((current.health?.consecutiveFailures??0)>=2||current.outageSeconds!=null),
    busy:state.connectionBusy||current.health?.switching&&'Switching…'||'',
    latencyMs:current.health?.latencyMs??current.lastGoodPingMs??current.initialLatencyMs,
    outageSeconds:current.outageSeconds??null,
    suggestion:switching.mode==='suggest'?current.health?.suggestion??null:null,
    error:trayPanel.error,
  };
  const key=JSON.stringify(snapshot);
  if(!force&&key===trayPanel.lastSnapshot)return;
  trayPanel.lastSnapshot=key;
  void nativeInvoke('publish_tray_panel',{snapshot}).catch(()=>{
    if(trayPanel.lastSnapshot===key)trayPanel.lastSnapshot='';
  });
}

function connectionError(error){
  const message=errorMessage(error);
  if(trayPanel.visible)trayPanel.error=message;
  toast(message);
}

async function handleTrayAction({action,serverId}){
  if(state.connectionBusy||state.connection.health?.switching)return;
  trayPanel.error='';
  if(action==='disconnect'){await disconnectConnection();return}
  if(action==='restoreProxy'){await restoreSystemProxy();return}
  if(action==='switch'){
    if(state.connection.health?.suggestion?.serverId!==serverId){
      connectionError('The suggested server changed. Choose a server from the updated list.');
      syncTrayPanel();
      return;
    }
    await respondToSwitch(false);
    return;
  }
  if(action==='retry'&&state.connection.serverId===serverId){
    connectionRevision++;
    state.connectionBusy='Retrying…';renderConnection();
    try{state.connection=await nativeInvoke('retry_tray_connection',{serverId})}
    catch(error){connectionError(error)}
    finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
    return;
  }
  if(action==='connect'&&state.servers.some(server=>server.id===serverId)){
    await connectSelected(serverId);
    if(state.connection.state==='connected'&&state.connection.serverId===serverId)setSelected(serverId);
    return;
  }
  syncTrayPanel(true);
}

function applyConnectionStatus(current){
  const previous=state.connection;
  state.connection=current;
  if(current.state==='connected'&&current.serverId)trayPanel.lastServer=current.serverId;
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
  trayPanel.error='';
  connectionRevision++;
  state.connectionBusy=state.connection.state==='connected'?'Switching…':'Connecting…';renderConnection();
  try{
    const outbound=outboundFromShareLink(server.uri);
    state.connection=await nativeInvoke('connect_server',{serverId:id,outbound,displayName:displayServerName(server)});
    trayPanel.lastServer=id;
    toast(state.connection.connectionMode==='tun'?'Connected · TUN is active':'Connected · Windows System Proxy is active');
  }catch(err){connectionError(err)}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}
async function disconnectConnection(){
  if(!nativeHost()||state.connectionBusy)return;
  connectionRevision++;
  trayPanel.error='';
  state.connectionBusy='Disconnecting…';renderConnection();
  try{state.connection=await nativeInvoke('disconnect_server');toast('Disconnected');}
  catch(err){connectionError(err)}
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
  }catch(error){connectionError(error)}
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
  trayPanel.error='';
  state.connectionBusy=undo?'Returning…':'Switching…';
  renderConnection();
  try{
    state.connection=await (undo?nativeInvoke('undo_server_switch'):
      nativeInvoke('accept_server_suggestion',{serverId:suggestion.serverId}));
    trayPanel.lastServer=state.connection.serverId;
    setSelected(state.connection.serverId);
  }catch(error){connectionError(error)}
  finally{state.connectionBusy=false;renderConnection();await refreshConnectionStatus({silent:true})}
}

function latencyView(server) {
  if(!server)return null;
  const feedback = pingFeedback.get(server.id);
  return feedback?.signature === server.signature ? {...server, ...feedback} : server;
}

function currentServer(server) {
  return state.servers.some(row => row.id === server.id && row.signature === server.signature);
}

function downloadView(server) {
  const result = downloadResults.get(server.id);
  return result?.signature === server.signature ? result : null;
}

async function measureLatency(server,samples,testId,onFirst) {
  const outbound=outboundFromShareLink(server.uri);
  const ipc=window.__TAURI_INTERNALS__;
  const args = {outbound, samples, testId};
  if(samples===1||!ipc.transformCallback)return nativeInvoke('measure_server_latency',args);
  const callback=ipc.transformCallback(({message})=>{
    if(message)onFirst(normalizedLatencyResult(message,1));
  });
  try {
    return await nativeInvoke('measure_server_latency',{...args,onFirst:`__CHANNEL__:${callback}`});
  } finally {
    ipc.unregisterCallback(callback);
  }
}
function pingServers(servers, samples) {
  return testServers(servers, samples, 'ping');
}

async function cancelServerTest() {
  const job = serverTest;
  if (!job || job.cancelled) return;
  job.cancelled = true;
  job.button.disabled = true;
  $('runtimeNotice').textContent = 'Cancelling server tests…';
  if (job.id !== undefined) {
    try { await nativeInvoke('cancel_manual_test', {testId: job.id}); }
    catch (error) { toast(errorMessage(error)); }
  }
}

async function testServers(servers,samples,kind){
  if(!nativeHost()){toast('Server tests require the desktop app and Xray-core');return}
  if(serverTest){toast('A server test is already running');return}
  if(!servers.length){toast('No configurations to test');return}
  const speed = kind === 'speed';
  const button = $(speed ? 'speedTestButton' : 'pingAllButton');
  const other = $(speed ? 'pingAllButton' : 'speedTestButton');
  const originalLabel = button.innerHTML;
  const originalTitle = button.title;
  const job = {kind, button, cancelled: false};
  serverTest = job;
  other.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.title = speed ? 'Cancel speed test' : 'Cancel ping';
  button.innerHTML = `${icon('close')} <span>${button.title}</span>`;
  const notice = $('runtimeNotice');
  const maxData = Math.min(servers.length, MAX_SPEED_SERVERS) * SPEED_SAMPLE_MB;
  const budget = speed ? ` · Up to ${maxData} MB of download data` : '';
  notice.textContent = `Pinging 0/${servers.length}${budget}`;
  try {
    job.id = await nativeInvoke('begin_manual_test', {speed});
    if (job.cancelled) {
      notice.textContent = 'Server test cancelled';
      return;
    }
    if (speed) downloadResults.clear();
    else pingFeedback.clear();
    render();
    const pingResults = new Map();
    const summary = await pingPool(servers,samples,
      server => measureLatency(server, samples, job.id, first => {
        if (serverTest !== job || job.cancelled || !currentServer(server)) return;
        pingFeedback.set(server.id, {...first, signature: server.signature, provisional: true});
        render();
      }),
      (server,result,done,total)=>{
        if (serverTest !== job) return;
        if (currentServer(server)) {
          if (speed) {
            if (Number.isFinite(result.latency)) pingResults.set(server.id, result.latency);
          } else {
            pingFeedback.delete(server.id);
            if (result.latencyStatus === 'cancelled') {
              pingFeedback.set(server.id, {...result, signature: server.signature});
            } else {
              safeAction(() => repo.setLatency(server.id, result));
              state.servers = repo.rows();
            }
            render();
          }
        }
        if (!job.cancelled) notice.textContent = `Pinging ${done}/${total}${budget}`;
      }, {concurrency: 3, shouldStop: () => job.cancelled});
    if (speed && !job.cancelled) {
      await runSpeedDownloads(job, servers.filter(currentServer), pingResults);
    } else {
      notice.textContent = `Ping ${summary.cancelled?'cancelled':'complete'} · ${summary.finished}/${summary.total} tested`;
    }
  } catch (error) {
    notice.textContent = job.cancelled ? 'Server test cancelled' : errorMessage(error);
  } finally {
    try {
      if (job.id !== undefined) await nativeInvoke('finish_manual_test', {testId: job.id});
    } catch (error) {
      toast(errorMessage(error));
    }
    if (!speed) {
      for (const [id, feedback] of pingFeedback) {
        if (feedback.provisional) pingFeedback.delete(id);
      }
      render();
    }
    serverTest = undefined;
    button.removeAttribute('aria-busy');
    button.disabled = false;
    button.innerHTML = originalLabel;
    button.title = originalTitle;
    other.disabled = false;
  }
}

async function runSpeedDownloads(job, servers, pingResults) {
  const {count, candidates} = speedCandidates(servers, pingResults);
  const notice = $('runtimeNotice');
  if (!candidates.length) {
    notice.textContent = 'No servers answered the ping';
    return;
  }
  const total = candidates.length;
  let measured = 0;
  for (const [index, server] of candidates.entries()) {
    if (job.cancelled) break;
    if (!currentServer(server)) continue;
    notice.textContent = `${count} answered · Download ${index + 1}/${total} · Up to ${total * SPEED_SAMPLE_MB} MB`;
    downloadResults.set(server.id, {signature: server.signature, label: 'Testing…'});
    render();
    try {
      const outbound = outboundFromShareLink(server.uri);
      const result = await nativeInvoke('measure_server_download', {outbound, testId: job.id});
      if (!currentServer(server)) continue;
      downloadResults.set(server.id, {...result, signature: server.signature});
      measured++;
    } catch (error) {
      if (!currentServer(server)) continue;
      const reason = errorMessage(error);
      const label = job.cancelled ? 'Cancelled' :
        reason === 'Insufficient download sample' ? 'Insufficient data' : 'Download failed';
      downloadResults.set(server.id, {signature: server.signature, label, reason});
    } finally {
      render();
    }
  }
  notice.textContent = `Speed test ${job.cancelled?'cancelled':'complete'} · ${measured}/${total} measured`;
}

function renderSort(){for(const btn of document.querySelectorAll('[data-sort]')){const active=btn.dataset.sort===state.sortKey;btn.dataset.active=String(active);btn.querySelector('.sort-indicator').innerHTML=icon(active?(state.sortDirection==='asc'?'up':'down'):'sort');btn.setAttribute('aria-sort',active?(state.sortDirection==='asc'?'ascending':'descending'):'none')}}
function orderedRows(){
  const servers = state.subscriptionFilterId
    ? state.servers.filter(server => server.subscriptionId === state.subscriptionFilterId)
    : state.servers;
  const rows = filterServers(servers, state.query).map(server => {
    const download = downloadView(server);
    return {...latencyView(server), download, downloadMbps: download?.mbps};
  });
  return sortServers(rows, state.sortKey, state.sortDirection);
}
function renderTable(){if(editNameId)return;const rows=orderedRows(),body=$('serverRows');const focused=body.contains(document.activeElement)?document.activeElement:null;const focusedId=focused?.closest('tr')?.dataset.id;body.replaceChildren();for(const s of rows){const tr=document.createElement('tr');tr.dataset.id=s.id;tr.classList.toggle('selected',s.id===state.selected);tr.tabIndex=0;tr.setAttribute('aria-selected',String(s.id===state.selected));
    const starCell=tr.insertCell();
    const actions=document.createElement('div');actions.className='row-actions';
    const star=document.createElement('button');star.type='button';star.className='star'+(s.favorite?' is-favorite':'');star.innerHTML=icon('star');star.title=s.favorite?'Remove favorite':'Add favorite';star.setAttribute('aria-label',`${s.favorite?'Unstar':'Star'} ${s.name}`);
    const pin=document.createElement('button');pin.type='button';pin.className='pin-button';pin.innerHTML=icon('pin');pin.title=s.pinned?'Unpin server':'Pin server';pin.setAttribute('aria-label',`${s.pinned?'Unpin':'Pin'} ${s.name}`);pin.setAttribute('aria-pressed',String(Boolean(s.pinned)));
    star.addEventListener('click',e=>{e.stopPropagation();toggleFavorite(s.id)});
    pin.addEventListener('click',e=>{e.stopPropagation();togglePin(s.id)});
    actions.addEventListener('dblclick',e=>e.stopPropagation());
    actions.append(star,pin);starCell.append(actions);
    const nameCell=tr.insertCell();
    const wrap=document.createElement('div');wrap.className='name-cell';
    const flag=document.createElement('span');flag.className='flag';renderFlag(flag,s,icon('globe'));
    const name=document.createElement('span');name.className='server-name';name.textContent=displayServerName(s);
    const rename=document.createElement('button');
    rename.type='button';rename.className='rename-config';rename.title='Rename configuration';
    rename.setAttribute('aria-label','Rename '+displayServerName(s));rename.innerHTML=icon('edit');
    rename.addEventListener('click',e=>{e.stopPropagation();startInlineRename(s,wrap,name,rename)});
    wrap.addEventListener('dblclick',e=>{if(e.target.closest('button,input'))e.stopPropagation()});
    wrap.append(flag,name,rename);nameCell.append(wrap);
    const typeCell=tr.insertCell();const type=document.createElement('span');type.className='type-label type-'+s.type.toLowerCase();type.textContent=s.type;typeCell.append(type);
    const latencyCell = tr.insertCell();
    const latency = document.createElement('span');
    const latencyLabels = {timeout: 'Timeout', error: 'Failed', 'start-failed': 'Failed to start', cancelled: 'Cancelled'};
    latency.className = 'latency-text ' + latencyClass(s.latency);
    latency.textContent = Number.isFinite(s.latency) ? String(s.latency) : latencyLabels[s.latencyStatus] ?? '—';
    latency.dataset.provisional = String(Boolean(s.provisional));
    if (s.provisional) latency.title = 'First reply · waiting for the average';
    latencyCell.append(latency);
    const count = latencyResponseCount(s);
    if (count) {
      const responses = document.createElement('span');
      responses.className = 'latency-responses';
      responses.textContent = count;
      responses.title = `${s.latencySuccess} replies out of ${s.latencyAttempted} probes`;
      latencyCell.append(responses);
    }
    const downloadCell = tr.insertCell();
    downloadCell.className = 'download-cell';
    const download = s.download;
    if (Number.isFinite(s.downloadMbps)) {
      const speed = document.createElement('strong');
      speed.textContent = `${speedNumber.format(s.downloadMbps)} Mbps`;
      speed.title = `${download.complete ? 'Full' : 'Partial'} sample · ${speedNumber.format(download.downloadedBytes / 1e6)} MB received`;
      downloadCell.append(speed);
    } else {
      downloadCell.textContent = download?.label ?? '—';
      downloadCell.title = download?.reason ?? '';
    }
    const sourceCell=tr.insertCell();sourceCell.className='source-cell';sourceCell.textContent=s.source;
    tr.addEventListener('click',()=>setSelected(s.id));tr.addEventListener('dblclick',()=>{setSelected(s.id);void connectSelected(s.id)});
    tr.addEventListener('contextmenu',e=>{e.preventDefault();setSelected(s.id);showContextMenu(s.id,e.clientX,e.clientY)});
    tr.addEventListener('keydown',e=>{if(e.target!==tr)return;if(e.key==='Enter'){e.preventDefault();setSelected(s.id);void connectSelected(s.id)}if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();setSelected(s.id);const rect=tr.getBoundingClientRect();showContextMenu(s.id,rect.left+150,rect.top+30)}});body.append(tr)}
  if(focusedId){const row=serverRow(focusedId);const control=focused.matches('.star')?row?.querySelector('.star'):focused.matches('.pin-button')?row?.querySelector('.pin-button'):row;control?.focus({preventScroll:true})}
  const empty = $('emptyMessage');
  empty.hidden = rows.length !== 0;
  empty.textContent = state.subscriptionFilterId
    ? 'No servers in this subscription match the current search.'
    : 'No configurations found. Use Paste or its menu to add servers.';
  renderSort();
  renderConnection();
}
function startInlineRename(server, wrap, name, button){
  if(editNameId)return;
  editNameId=server.id;
  const input=document.createElement('input');
  input.className='rename-input';input.type='text';input.maxLength=160;
  input.value=server.name;input.setAttribute('aria-label','Configuration name');
  let closed=false;
  const finish=(save,restoreFocus=false)=>{
    if(closed)return;
    if(save&&input.value.trim()&&!safeAction(()=>repo.renameServer(server.id,input.value)))return;
    closed=true;
    editNameId=null;
    sync();
    if(save&&nativeHost()){
      const renamed=state.servers.find(item=>item.id===server.id);
      if(renamed)void nativeInvoke('rename_active_server',{serverId:server.id,displayName:displayServerName(renamed)}).catch(()=>{});
    }
    if(restoreFocus)serverRow(server.id)?.querySelector('.rename-config')?.focus({preventScroll:true});
  };
  input.addEventListener('click',event=>event.stopPropagation());
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key==='Escape'){
      event.preventDefault();event.stopPropagation();
      finish(event.key==='Enter',true);
    }
  });
  input.addEventListener('blur',()=>finish(input.value!==server.name));
  wrap.replaceChild(input,name);
  button.hidden=true;
  input.focus();input.select();
}
function render(){renderTable()}
function toggleFavorite(id){if(safeAction(()=>repo.toggleFavorite(id)))sync()}
function togglePin(id){if(safeAction(()=>repo.togglePin(id)))sync()}
function closeContextMenu(){$('contextMenu').hidden=true;state.contextId=null}
function addMenuButton(parent,iconName,label,action,{disabled=false,danger=false}={}){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.className='menu-button'+(danger?' menu-danger':'');button.disabled=disabled;const iconSpan=document.createElement('span');iconSpan.className='menu-icon';iconSpan.innerHTML=icon(iconName);const txt=document.createElement('span');txt.textContent=label;button.append(iconSpan,txt);if(!disabled)button.addEventListener('click',()=>{closeContextMenu();action()});parent.append(button);return button}
function showContextMenu(id,x,y){const s=state.servers.find(s=>s.id===id);if(!s)return;state.contextId=id;const menu=$('contextMenu');menu.replaceChildren();addMenuButton(menu,'play','Connect / Select',()=>{setSelected(id);void connectSelected(id)});for(const samples of [1,2,3])addMenuButton(menu,'activity',`Ping (×${samples})${samples>1?' — Average':''}`,()=>void pingServers([s],samples));const div=document.createElement('div');div.className='menu-divider';menu.append(div);addMenuButton(menu,'star',s.favorite?'Remove Favorite':'Set as Favorite',()=>toggleFavorite(id));addMenuButton(menu,'pin',s.pinned?'Unpin server':'Pin server',()=>togglePin(id));addMenuButton(menu,'edit',s.subscriptionId?'Edit (subscription-managed)':'Edit',()=>openManualDialog(id),{disabled:Boolean(s.subscriptionId)});addMenuButton(menu,'copy','Duplicate as manual',()=>{if(safeAction(()=>repo.duplicateManual(id)))sync()});addMenuButton(menu,'delete','Delete',()=>removeServer(id),{danger:true});if(s.subscriptionId){const note=document.createElement('div');note.className='menu-note';note.textContent='Deleting this subscription node hides it from future refreshes';menu.append(note)}menu.hidden=false;menu.style.left='0px';menu.style.top='0px';const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-bounds.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-bounds.height-8))}px`}
function closePasteMenu(){$('pasteMenu').hidden=true;$('pasteMenuButton').setAttribute('aria-expanded','false')}
function showDialog(id){const target=$(id);for(const dialog of document.querySelectorAll('dialog[open]')){if(dialog!==target)dialog.close()}if(!target.open)target.showModal()}
function confirmAction(title,description,acceptLabel='Delete',keepLabel=null){return new Promise(resolve=>{const dialog=$('confirmDialog');$('confirmTitle').textContent=title;$('confirmDescription').textContent=description;$('confirmAccept').textContent=acceptLabel;$('confirmKeep').hidden=!keepLabel;if(keepLabel)$('confirmKeep').textContent=keepLabel;let done=false;const finish=result=>{if(done)return;done=true;dialog.close();dialog.removeEventListener('close',cancel);$('confirmCancel').removeEventListener('click',onCancel);$('confirmClose').removeEventListener('click',onCancel);$('confirmAccept').removeEventListener('click',onYes);$('confirmKeep').removeEventListener('click',onKeep);resolve(result)};const cancel=()=>finish(false),onCancel=()=>finish(false),onYes=()=>finish(true),onKeep=()=>finish('keep');dialog.addEventListener('close',cancel);$('confirmCancel').addEventListener('click',onCancel);$('confirmClose').addEventListener('click',onCancel);$('confirmAccept').addEventListener('click',onYes);$('confirmKeep').addEventListener('click',onKeep);showDialog('confirmDialog')})}
async function removeServer(id){const s=state.servers.find(x=>x.id===id);if(!s)return;const answer=await confirmAction('Delete configuration?',s.subscriptionId?'This node will be hidden on future subscription updates.':'This manual configuration will be removed from local storage.');if(!answer)return;if(state.connection.state==='connected'&&state.connection.serverId===id){await disconnectConnection();if(state.connection.state==='connected')return}if(safeAction(()=>repo.deleteServer(id)))sync()}
function openManualDialog(id=null){closePasteMenu();$('manualError').textContent='';state.editingId=id;const s=state.servers.find(x=>x.id===id);$('manualDialogTitle').textContent=s?'Edit configuration':'Add server';$('manualUri').value=s?.uri||'';$('manualName').value=s?.name||'';showDialog('manualDialog');$('manualUri').focus()}
function openSubscriptionDialog(url='', subscription=null){
  closePasteMenu();
  state.editingSubscriptionId = subscription?.id ?? null;
  $('subscriptionError').textContent = '';
  $('subscriptionDialogTitle').textContent = subscription ? 'Edit subscription' : 'Add subscription';
  $('subscriptionSaveButton').textContent = subscription ? 'Save changes' : 'Save & Update';
  $('subscriptionSaveButton').disabled = state.updating;
  $('subscriptionName').value = subscription?.name ?? '';
  $('subscriptionUrl').value = subscription?.url ?? url;
  $('subscriptionRefreshHours').value = String(subscription?.autoRefreshHours ?? 0);
  showDialog('subscriptionDialog');
  $('subscriptionName').focus();
}
function openManager(){closePasteMenu();renderSubscriptionList();showDialog('manageDialog')}
function renderSubscriptionFilter(subscriptions){
  const subscription = subscriptions.find(item => item.id === state.subscriptionFilterId);
  if (!subscription) state.subscriptionFilterId = null;
  $('clearSubscriptionFilter').hidden = !subscription;
  $('subscriptionFilterName').textContent = subscription?.name ?? '';
  $('clearSubscriptionFilter').setAttribute('aria-label',
    subscription ? `Clear subscription filter: ${subscription.name}` : 'Clear subscription filter');
}
function renderSubscriptionList(subscriptions=repo.snapshot().subscriptions){
  $('subscriptionSaveButton').disabled = state.updating;
  const list = $('subscriptionList');
  list.replaceChildren();
  if (!subscriptions.length) {
    const text = document.createElement('p');
    text.className = 'manager-empty';
    text.textContent = 'No subscriptions yet. Add one by name and URL.';
    list.append(text);
    return;
  }
  const serverCounts = new Map();
  for (const {subscriptionId} of state.servers) {
    if (subscriptionId) serverCounts.set(subscriptionId, (serverCounts.get(subscriptionId) ?? 0) + 1);
  }
  for (const sub of subscriptions) {
    const item = document.createElement('div');
    item.className = 'subscription-card';
    const meta = document.createElement('div');
    meta.className = 'subscription-meta';
    const titleRow = document.createElement('p');
    titleRow.className = 'subscription-title-row';
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'subscription-title';
    title.textContent = sub.name;
    title.title = 'Show only servers from this subscription';
    title.addEventListener('click', () => {
      state.subscriptionFilterId = sub.id;
      $('searchInput').value = state.query = '';
      renderSubscriptionFilter(subscriptions);
      render();
      $('manageDialog').close();
      $('clearSubscriptionFilter').focus();
    });
    titleRow.append(title);
    const info = document.createElement('p');
    const lastUpdated = sub.updatedAt ? new Date(sub.updatedAt).toLocaleString() : 'Not updated yet';
    const automatic = sub.autoRefreshHours ? ` · Auto-update every ${sub.autoRefreshHours} h` : '';
    info.textContent = `${serverCounts.get(sub.id) ?? 0} servers · ${lastUpdated}${automatic}`;
    meta.append(titleRow, info);
    if (sub.lastError) {
      const error = document.createElement('p');
      error.className = 'sub-error';
      error.textContent = sub.lastError;
      error.title = sub.lastError;
      meta.append(error);
    }
    const controls = document.createElement('div');
    controls.className = 'subscription-actions';
    for (const [text, action, className] of [
      ['Update', () => void updateSubscriptions([sub]), ''],
      ['Edit', () => openSubscriptionDialog('', sub), ''],
      ['Delete', () => void removeSubscription(sub.id), 'delete-sub'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.className = className;
      button.disabled = state.updating;
      button.addEventListener('click', action);
      controls.append(button);
    }
    item.append(meta, controls);
    list.append(item);
  }
}
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
async function updateSubscriptions(subscriptions, {quiet=false, summary=false}={}) {
  if (state.updating || !subscriptions.length) return;
  state.updating = true;
  renderSubscriptionList();
  let succeeded = 0;
  try {
    for (const sub of subscriptions) {
      if (!quiet) toast(`Updating “${sub.name}”…`);
      try {
        const response = await fetchSubscription(sub.url);
        const stats = repo.refreshSubscription(sub.id, response);
        succeeded++;
        if (!quiet) {
          const skipped = stats.invalid ? `, ${stats.invalid} skipped` : '';
          toast(`Updated “${sub.name}”: ${stats.added} added, ${stats.retained} retained, ${stats.removed} removed${skipped}`);
        }
      } catch (error) {
        const reason = errorMessage(error);
        const saveError = () => repo.setSubscriptionError(sub.id, reason);
        if (quiet) {
          try { saveError(); } catch { break; }
        } else {
          safeAction(saveError);
          toast(`${sub.name}: ${reason}`);
        }
      }
    }
  } finally {
    state.updating = false;
    sync();
  }
  if (summary) toast(`Subscription update complete: ${succeeded}/${subscriptions.length} succeeded`);
}
async function updateAll(){
  const {subscriptions} = repo.snapshot();
  if (!subscriptions.length) {
    toast('No subscriptions to update. Add a subscription first.');
    return;
  }
  await updateSubscriptions(subscriptions, {summary:true});
}
async function submitSubscription(){
  if (state.updating) return;
  const name = $('subscriptionName').value;
  const url = $('subscriptionUrl').value;
  const autoRefreshHours = Number($('subscriptionRefreshHours').value);
  const editingId = state.editingSubscriptionId;
  let subscription;
  let shouldUpdate = true;
  try {
    if (editingId) {
      const edited = repo.editSubscription(editingId, {name, url, autoRefreshHours});
      subscription = edited.subscription;
      shouldUpdate = edited.urlChanged;
    } else {
      subscription = repo.addSubscription(name, url, autoRefreshHours);
    }
  } catch (error) {
    $('subscriptionError').textContent = errorMessage(error);
    return;
  }
  $('subscriptionDialog').close();
  sync();
  if (editingId) openManager();
  if (shouldUpdate) await updateSubscriptions([subscription]);
  if (!editingId && state.pendingSubscriptionUrls.length && !document.querySelector('dialog[open]')) {
    openSubscriptionDialog(state.pendingSubscriptionUrls.shift());
  }
}
async function importClipboard(){let text;try{text=await readClipboardText()}catch(e){toast(errorMessage(e));openManualDialog();return}if(!text?.trim()){toast('Clipboard is empty');return}
  const before=repo.rows().length;let result;try{result=repo.importManual(text)}catch(e){toast(errorMessage(e));return}sync();if(result.servers.length)toast(`Added ${repo.rows().length-before} new configuration(s)${result.errors.length?`; ${result.errors.length} unsupported/invalid`:''}`);else if(result.errors.length)toast(`Could not import: ${result.errors[0].reason}`);
  if(result.subscriptionUrls.length){state.pendingSubscriptionUrls=result.subscriptionUrls.slice(1);openSubscriptionDialog(result.subscriptionUrls[0])}
}
function init(){if(nativeHost())document.documentElement.classList.add('native-host');applyTheme();$('pingSamples').value=String(state.pingSamples);sync();if(repo.loadError)toast(repo.loadError);
  if(!nativeHost()){$('phaseStatus').textContent='Browser preview';$('runtimeNotice').textContent='Real connection and Ping require the Windows desktop host';}
  else{initWindowChrome();void refreshConnectionStatus({silent:true}).then(()=>configUpdate.catch(()=>{})).then(()=>readDesktopSettings());setInterval(()=>void refreshConnectionStatus({silent:true}),1500)}
  renderDesktopSettings();
  window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change',()=>{if(state.appearance==='system')applyTheme()});
  document.querySelectorAll('[data-sort]').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.sort;if(!SORT_COLUMNS.includes(key))return;if(key===state.sortKey)state.sortDirection=state.sortDirection==='asc'?'desc':'asc';else{state.sortKey=key;state.sortDirection=key==='favorite'||key==='downloadMbps'?'desc':'asc'}render()}));
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value;render()});
  $('clearSubscriptionFilter').addEventListener('click', () => {
    state.subscriptionFilterId = null;
    renderSubscriptionFilter([]);
    render();
    $('searchInput').focus();
  });
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
  $('phoneTransferButton').disabled=!nativeHost();
  phoneTransferControls({
    invoke:nativeInvoke,showDialog,
    onSubscription(url){
      state.pendingSubscriptionUrls = [];
      openSubscriptionDialog(url);
    },
    onReceive(link){
      const result=repo.receiveFromPhone(link);
      sync();
      return result;
    },
    async onTest({id,outbound}){
      const before=state.servers.find(server=>server.id===id);
      if(!before)return null;
      const result=normalizedLatencyResult(await nativeInvoke('measure_server_latency',{outbound,samples:1}),1);
      if(!state.servers.some(server=>server.id===id&&server.signature===before.signature))return null;
      repo.setLatency(id,result);
      state.servers=repo.rows();
      render();
      return result.latency;
    },
    onConnect(id){setSelected(id);void connectSelected(id)}
  });
  $('pasteMenuButton').addEventListener('click',()=>{const menu=$('pasteMenu');menu.hidden=!menu.hidden;$('pasteMenuButton').setAttribute('aria-expanded',String(!menu.hidden))});
  $('manualAddButton').addEventListener('click',()=>openManualDialog());
  $('subscriptionAddButton').addEventListener('click',()=>openSubscriptionDialog());
  $('subscriptionManageButton').addEventListener('click',openManager);
  $('settingsSubscriptions').addEventListener('click',openManager);
  $('managerAddButton').addEventListener('click',()=>openSubscriptionDialog());
  $('manualForm').addEventListener('submit',e=>{e.preventDefault();const uri=$('manualUri').value,name=$('manualName').value;try{if(state.editingId)repo.updateManual(state.editingId,uri,name);else repo.addManual({uri,name});$('manualDialog').close();sync();toast('Configuration saved locally')}catch(err){$('manualError').textContent=errorMessage(err)}});
  $('subscriptionForm').addEventListener('submit',e=>{e.preventDefault();void submitSubscription()});
  if (nativeHost()) setInterval(() => {
    if (!state.updating && !$('subscriptionDialog').open && !$('confirmDialog').open) {
      void updateSubscriptions(repo.dueSubscriptions(), {quiet:true});
    }
  }, SUBSCRIPTION_CHECK_INTERVAL);
  $('updateButton').addEventListener('click',()=>void updateAll());
  $('pingAllButton').addEventListener('click',()=>{
    if(serverTest?.kind==='ping')void cancelServerTest();
    else void pingServers(state.servers,state.pingSamples);
  });
  $('speedTestButton').addEventListener('click', () => {
    if (serverTest?.kind === 'speed') void cancelServerTest();
    else void testServers(state.servers, 1, 'speed');
  });
  routingEditor=createRoutingEditor({invoke:nativeInvoke,showDialog,nativeHost,onSaved:async changed=>{
    if(changed&&state.connection.state==='connected'){
      const id=state.connection.serverId;
      await disconnectConnection();
      if(state.connection.state!=='connected')await connectSelected(id);
    }
  }});
  $('settingsRouting').addEventListener('click',()=>void routingEditor.open());
  $('ipHistoryButton').addEventListener('click',async()=>{
    const server=state.servers.find(row=>row.id===(state.connection.serverId??state.selected));
    if(!server)return;
    $('ipHistoryServer').textContent=displayServerName(server);
    try{renderIpHistory($('ipHistoryList'),await nativeInvoke('exit_ip_history',{serverId:server.id}));showDialog('ipHistoryDialog')}
    catch(error){toast(errorMessage(error))}
  });
  $('openReport').disabled=!nativeHost();
  $('openReport').addEventListener('click',async()=>{
    $('helpMenu').open=false;
    try{$('reportText').value=await nativeInvoke('error_report');showDialog('reportDialog')}
    catch(error){toast(errorMessage(error))}
  });
  $('copyReport').addEventListener('click',async()=>{
    try{await nativeInvoke('copy_error_report',{text:$('reportText').value});toast('Report copied')}
    catch(error){toast(errorMessage(error))}
  });
  $('settingsButton').addEventListener('click',()=>showDialog('settingsDialog'));
  $('startupToggle').addEventListener('change',e=>void changeDesktopSetting('startup',e.target.checked));
  $('trayToggle').addEventListener('change',e=>void changeDesktopSetting('minimizeToTray',e.target.checked));
  $('autoConnectToggle').addEventListener('change',e=>void changeDesktopSetting('autoConnect',e.target.checked));
  window.addEventListener('simpleray:tray-panel-visible',event=>{
    const visible=event.detail===true;
    if(visible&&!trayPanel.visible)trayPanel.error='';
    trayPanel.visible=visible;
    if(!visible)return;
    syncTrayPanel(true);
    void refreshConnectionStatus({silent:true});
    void nativeInvoke('get_routing_settings').then(settings=>{
      trayPanel.mode=settings.mode;
      syncTrayPanel();
    }).catch(()=>{});
  });
  window.addEventListener('simpleray:tray-panel-action',event=>void handleTrayAction(event.detail));
  window.addEventListener('simpleray:tray-toggle',()=>void toggleConnection());
  window.addEventListener('simpleray:tray-switched',event=>{
    connectionRevision++;
    if(state.servers.some(server=>server.id===event.detail))setSelected(event.detail);
    void refreshConnectionStatus({silent:true});
  });
  window.addEventListener('simpleray:exit-blocked',()=>toast('Cannot exit safely: System Proxy restoration failed. Restore Windows proxy settings before forcing exit.'));
  $('settingsClose').addEventListener('click',()=>$('settingsDialog').close());
  for(const b of document.querySelectorAll('[data-close]'))b.addEventListener('click',()=>$(b.dataset.close).close());
  for(const input of document.querySelectorAll('input[name="palette"], input[name="appearance"]')){
    input.addEventListener('change',()=>{
      state[input.name]=input.value;
      applyTheme();
      persist();
    });
  }
  colorWheel=attachColorWheel({
    canvas:$('themeWheel'),target:$('wheelTarget'),lightness:$('wheelLightness'),
    read:field=>state[field],write:(field,value)=>{state[field]=value;applyTheme()},commit:persist
  });
  for(const [id,field,fallback] of [
    ['primaryColor','themePrimary',THEME_COLORS.primary],
    ['accentColor','themeAccent',THEME_COLORS.accent]
  ]){
    $(id).addEventListener('input',e=>{
      state[field]=themeColor(e.target.value,fallback);
      applyTheme();
    });
    $(id).addEventListener('change',persist);
  }
  $('pingSamples').addEventListener('change',e=>{state.pingSamples=Number(e.target.value);persist();toast(`Ping All: ${state.pingSamples} real-delay probe${state.pingSamples===1?'':'s'} per server`)});
  document.addEventListener('click',e=>{if(!e.target.closest('#contextMenu'))closeContextMenu();if(!e.target.closest('.paste-group'))closePasteMenu()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeContextMenu();closePasteMenu()}});
  window.addEventListener('resize',closeContextMenu);
}
init();
