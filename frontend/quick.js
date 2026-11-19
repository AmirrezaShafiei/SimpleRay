import {createRepository,STORAGE_KEY} from './store.js';
import {outboundFromShareLink} from './xray-config.js';
import {readAppearance,applyAppearance,PREFERENCES_KEY} from './appearance.js';
const el=id=>document.getElementById(id);
const invoke=(name,args={})=>window.__TAURI_INTERNALS__?.invoke?.(name,args);
let status={state:'disconnected',serverId:null},busy=false,term='',autoTimer;
const rows=()=>createRepository(localStorage).rows();
function theme(){applyAppearance(document.documentElement,readAppearance(localStorage),window.matchMedia?.('(prefers-color-scheme: light)').matches)}
function message(s){el('quickMessage').textContent=s}
function render(){
 theme();const all=rows(),current=all.find(x=>x.id===status.serverId),q=term.toLowerCase();
 el('quickDot').classList.toggle('connected',status.state==='connected');
 el('quickStatus').textContent=status.state==='connected'?'Connected':status.state==='connecting'?'Connecting…':'Disconnected';
 el('activeName').textContent=current?.name||'';
 const shown=all.filter(x=>[x.name,x.type,x.source].some(v=>String(v||'').toLowerCase().includes(q))).sort((a,b)=>Number(Boolean(b.favorite))-Number(Boolean(a.favorite))||a.name.localeCompare(b.name));
 el('totalCount').textContent=String(shown.length);
 const target=el('quickServers');target.replaceChildren();
 if(!shown.length){const p=document.createElement('p');p.className='empty';p.textContent='No servers found';target.append(p)}
 for(const server of shown){
  const b=document.createElement('button');b.type='button';b.className='server';b.classList.toggle('selected',server.id===status.serverId);b.disabled=busy;
  const star=document.createElement('span');star.className='star';star.textContent=server.favorite?'★':'';
  const name=document.createElement('span');name.className='name';const title=document.createElement('strong');title.textContent=server.name;const desc=document.createElement('small');desc.textContent=server.type+' · '+server.source;name.append(title,desc);
  const lat=document.createElement('span');lat.className='latency';lat.classList.add(server.latency<180?'good':server.latency<440?'medium':'slow');lat.textContent=Number.isFinite(server.latency)?server.latency+' ms':'—';
  b.append(star,name,lat);b.addEventListener('click',()=>void change(server.id));target.append(b);
 }
 const decision=status.health?.suggestion;const suggestion=all.find(x=>x.id===decision?.serverId);
 el('suggestion').hidden=!suggestion;
 if(suggestion){el('suggestName').textContent=suggestion.name;el('suggestDetail').textContent=(decision.previousMs==null?'':decision.previousMs+' ms → ')+decision.candidateMs+' ms';el('acceptSuggestion').dataset.serverId=suggestion.id;el('acceptSuggestion').disabled=busy}
}
async function refresh(){if(!invoke)return;try{status=await invoke('connection_status');render()}catch{message('Could not read status')}}
async function change(id,accept=false){
 if(busy)return;const server=rows().find(x=>x.id===id);if(!server)return;
 busy=true;message(accept?'Applying suggestion…':'Connecting…');render();
 try{
  status=accept?await invoke('accept_server_suggestion',{serverId:id}):await invoke('connect_server',{serverId:id,outbound:outboundFromShareLink(server.uri)});
  createRepository(localStorage).setSelected(id);message('Connected to '+server.name);await invoke('hide_quick_panel');
 }catch(e){message(e?.message||String(e))}
 finally{busy=false;void refresh()}
}
el('quickSearch').addEventListener('input',e=>{term=e.target.value;render()});
el('acceptSuggestion').addEventListener('click',()=>void change(el('acceptSuggestion').dataset.serverId,true));
el('openMain').addEventListener('click',async()=>{await invoke('show_main_window');await invoke('hide_quick_panel')});
el('closeQuick').addEventListener('click',()=>void invoke('hide_quick_panel'));
window.addEventListener('focus',()=>void refresh());
window.addEventListener('storage',e=>{if([STORAGE_KEY,PREFERENCES_KEY].includes(e.key))void refresh()});
window.addEventListener('keydown',e=>{if(e.key==='Escape')void invoke('hide_quick_panel')});
window.addEventListener('simpleray:auto-suggest',()=>{void refresh();clearTimeout(autoTimer);autoTimer=setTimeout(()=>void invoke('hide_quick_panel'),16000)});
window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change',theme);
setInterval(()=>{if(!document.hidden&&!busy)void refresh()},2400);theme();void refresh();
