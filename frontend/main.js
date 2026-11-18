import {DEMO_SERVERS, filterServers, sortServers, latencyClass, SORT_COLUMNS} from './model.js';
const $=id=>document.getElementById(id);
const KEY='simpleray.phase1.preferences.v1';
const safeLoad=()=>{try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch{return {}}};
const pref=safeLoad();
const state={servers:DEMO_SERVERS.map(s=>({...s,favorite:pref.favorites?.includes(s.id)??s.favorite})),selected:pref.selected&&DEMO_SERVERS.some(s=>s.id===pref.selected)?pref.selected:'demo-de',sortKey:null,sortDirection:'asc',query:'',previewConnected:false,theme:['dark','light','system'].includes(pref.theme)?pref.theme:'system',pingSamples:pref.pingSamples===1?1:3,contextId:null};
let toastTimeout;
function persist(){try{localStorage.setItem(KEY,JSON.stringify({favorites:state.servers.filter(s=>s.favorite).map(s=>s.id),selected:state.selected,theme:state.theme,pingSamples:state.pingSamples}))}catch{/* browsers may prohibit storage */}}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('visible'),3200)}
function resolvedTheme(){return state.theme==='system'?(window.matchMedia?.('(prefers-color-scheme: light)').matches?'light':'dark'):state.theme}
function applyTheme(){document.documentElement.dataset.theme=resolvedTheme();$('themeSelect').value=state.theme}
window.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change',()=>{if(state.theme==='system')applyTheme()});
function getSelected(){return state.servers.find(s=>s.id===state.selected)||state.servers[0]}
function setSelected(id){if(!state.servers.some(s=>s.id===id))return;state.selected=id;persist();render();}
function renderConnection(){const s=getSelected();$('connectionSwitch').setAttribute('aria-checked',String(state.previewConnected));$('connectionState').textContent=state.previewConnected?'Connected · Preview':'Disconnected';$('stateLed').title=state.previewConnected?'UI preview only':'Disconnected';$('selectedFlag').textContent=s.flag;$('selectedText').textContent=`${s.name} · ${s.type}`;
  $('traffic').hidden=!state.previewConnected;$('selectedLatency').innerHTML='';const value=document.createTextNode(typeof s.latency==='number'?String(s.latency):'—');const unit=document.createElement('span');unit.textContent=typeof s.latency==='number'?' ms':'';$('selectedLatency').append(value,unit);$('selectedLatency').className=latencyClass(s.latency);$('connectionSwitch').closest('.connection-panel').classList.toggle('preview-on',state.previewConnected);
}
function renderSort(){for(const btn of document.querySelectorAll('[data-sort]')){const active=btn.dataset.sort===state.sortKey;btn.dataset.active=String(active);btn.querySelector('.sort-indicator').textContent=active?(state.sortDirection==='asc'?'↑':'↓'):'↕';btn.setAttribute('aria-sort',active?(state.sortDirection==='asc'?'ascending':'descending'):'none')}}
function orderedRows(){let rows=filterServers(state.servers,state.query);if(state.sortKey)rows=sortServers(rows,state.sortKey,state.sortDirection);return rows}
function renderTable(){const rows=orderedRows(),body=$('serverRows');body.replaceChildren();for(const s of rows){const tr=document.createElement('tr');tr.dataset.id=s.id;tr.classList.toggle('selected',s.id===state.selected);tr.tabIndex=0;tr.setAttribute('aria-selected',String(s.id===state.selected));
    const starCell=tr.insertCell();const star=document.createElement('button');star.className='star'+(s.favorite?' is-favorite':'');star.textContent=s.favorite?'★':'☆';star.title=s.favorite?'Remove favorite':'Add favorite';star.setAttribute('aria-label',`${s.favorite?'Unstar':'Star'} ${s.name}`);star.addEventListener('click',e=>{e.stopPropagation();toggleFavorite(s.id)});starCell.append(star);
    const nameCell=tr.insertCell();const wrap=document.createElement('div');wrap.className='name-cell';const flag=document.createElement('span');flag.className='flag';flag.textContent=s.flag;const name=document.createElement('span');name.className='server-name';name.textContent=s.name;wrap.append(flag,name);nameCell.append(wrap);
    const typeCell=tr.insertCell();const type=document.createElement('span');type.className='type-label type-'+s.type.toLowerCase();type.textContent=s.type;typeCell.append(type);
    const latencyCell=tr.insertCell();const latency=document.createElement('span');latency.className='latency-text '+latencyClass(s.latency);latency.textContent=typeof s.latency==='number'?`${s.latency}`:'—';latencyCell.append(latency);
    const sourceCell=tr.insertCell();sourceCell.className='source-cell';sourceCell.textContent=s.source;
    tr.addEventListener('click',()=>setSelected(s.id));tr.addEventListener('dblclick',()=>{setSelected(s.id);state.previewConnected=true;renderConnection();toast('Connected state preview only · No Xray core is running')});
    tr.addEventListener('contextmenu',e=>{e.preventDefault();setSelected(s.id);showContextMenu(s.id,e.clientX,e.clientY)});
    tr.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();setSelected(s.id)}if(e.key==='ContextMenu'||(e.shiftKey&&e.key==='F10')){e.preventDefault();setSelected(s.id);const rect=tr.getBoundingClientRect();showContextMenu(s.id,rect.left+150,rect.top+30)}});
    body.append(tr);
  }
  $('emptyMessage').hidden=rows.length!==0;$('sampleCount').textContent=`${rows.length} of ${state.servers.length} sample servers`;renderSort();renderConnection();
}
function render(){renderTable()}
function toggleFavorite(id){const s=state.servers.find(s=>s.id===id);if(!s)return;s.favorite=!s.favorite;persist();render();}
function closeContextMenu(){$('contextMenu').hidden=true;state.contextId=null}
function addMenuButton(parent,icon,label,action,{disabled=false,danger=false}={}){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.className='menu-button'+(danger?' menu-danger':'');button.disabled=disabled;const iconSpan=document.createElement('span');iconSpan.className='menu-icon';iconSpan.textContent=icon;const txt=document.createElement('span');txt.textContent=label;button.append(iconSpan,txt);if(!disabled)button.addEventListener('click',()=>{closeContextMenu();action()});parent.append(button);return button}
function showContextMenu(id,x,y){const s=state.servers.find(s=>s.id===id);if(!s)return;state.contextId=id;const menu=$('contextMenu');menu.replaceChildren();addMenuButton(menu,'▷','Connect (preview only)',()=>{state.previewConnected=true;renderConnection();toast('Connected state preview only · No real proxy connection')});addMenuButton(menu,'⌁','Ping (×1)',()=>toast('Real per-server Ping is planned for Phase 4'));addMenuButton(menu,'≋','Ping (×3) — Average',()=>toast('Real average Ping is planned for Phase 4'));const div=document.createElement('div');div.className='menu-divider';menu.append(div);addMenuButton(menu,s.favorite?'★':'☆',s.favorite?'Remove Favorite':'Set as Favorite',()=>toggleFavorite(id));addMenuButton(menu,'✎','Edit (Phase 2)',()=>{}, {disabled:true});addMenuButton(menu,'▣','Duplicate (Phase 2)',()=>{}, {disabled:true});addMenuButton(menu,'♲','Delete (Phase 2)',()=>{}, {disabled:true,danger:true});const note=document.createElement('div');note.className='menu-note';note.textContent='Actions are demo-only in Phase 1';menu.append(note);menu.hidden=false;const bounds=menu.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(x,window.innerWidth-bounds.width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,window.innerHeight-bounds.height-8))}px`}
function init(){if(window.__TAURI_INTERNALS__)document.documentElement.classList.add('native-host');applyTheme();$('pingSamples').value=String(state.pingSamples);render();
  document.querySelectorAll('[data-sort]').forEach(btn=>btn.addEventListener('click',()=>{const key=btn.dataset.sort;if(!SORT_COLUMNS.includes(key))return;if(key===state.sortKey)state.sortDirection=state.sortDirection==='asc'?'desc':'asc';else {state.sortKey=key;state.sortDirection=key==='favorite'?'desc':'asc'}render()}));
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value;render()});
  $('connectionSwitch').addEventListener('click',()=>{state.previewConnected=!state.previewConnected;renderConnection();toast('Connection switch preview only · Proxy not activated')});
  $('selectedServer').addEventListener('click',()=>{const row=document.querySelector(`tr[data-id="${state.selected}"]`);row?.scrollIntoView({block:'nearest',behavior:'smooth'});row?.focus()});
  $('pasteButton').addEventListener('click',()=>toast('Clipboard import is planned for Phase 2'));
  $('updateButton').addEventListener('click',()=>toast('Subscription update is planned for Phase 2'));
  $('pingAllButton').addEventListener('click',()=>toast(`Real Ping All (×${state.pingSamples}) is planned for Phase 4`));
  $('settingsButton').addEventListener('click',()=>{$('settingsDialog').showModal()});
  $('settingsClose').addEventListener('click',()=>{$('settingsDialog').close()});
  $('themeSelect').addEventListener('change',e=>{state.theme=e.target.value;applyTheme();persist()});
  $('pingSamples').addEventListener('change',e=>{state.pingSamples=Number(e.target.value)===1?1:3;persist();toast(`Future Ping All set to ${state.pingSamples} probe${state.pingSamples>1?'s (average)':''}`)});
  document.addEventListener('click',e=>{if(!e.target.closest('#contextMenu'))closeContextMenu()});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeContextMenu()});
  window.addEventListener('resize',closeContextMenu);
}
init();
