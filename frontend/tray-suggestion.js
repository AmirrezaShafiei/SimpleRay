import {paintAppearance,restoreAppearance,savedPreferences} from './theme.js';

const card=document.querySelector('.suggestion-card');
const name=document.getElementById('suggestionName');
const details=document.getElementById('suggestionDetails');
const switchButton=document.getElementById('suggestionSwitch');
const systemScheme=window.matchMedia('(prefers-color-scheme: light)');
const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
let offer;
let timer;

function refreshAppearance() {
  paintAppearance(document.documentElement,restoreAppearance(savedPreferences(localStorage)),systemScheme.matches);
}

async function dismiss() {
  clearTimeout(timer);
  await invoke('dismiss_tray_suggestion').catch(()=>{});
}

window.addEventListener('simpleray:suggestion',event=>{
  clearTimeout(timer);
  refreshAppearance();
  offer=event.detail;
  const decision=offer.decision;
  name.textContent=offer.name||'Suggested server';
  name.title=name.textContent;
  details.dataset.state='';
  details.textContent=decision.reason==='recovery'
    ? `Current server is unresponsive · ${decision.candidateMs} ms`
    : `${decision.previousMs} → ${decision.candidateMs} ms · Faster response`;
  card.hidden=false;
  switchButton.disabled=false;
  switchButton.hidden=false;
  switchButton.textContent='Switch server';
  timer=setTimeout(()=>void dismiss(),15_000);
});

switchButton.addEventListener('click',async()=>{
  if(!offer||switchButton.disabled)return;
  const selected=offer;
  clearTimeout(timer);
  switchButton.disabled=true;
  switchButton.textContent='Switching…';
  try{
    await invoke('accept_tray_suggestion',{
      serverId:selected.decision.serverId,
      generation:selected.generation,
      revision:selected.revision,
    });
    details.textContent='Connected to the suggested server';
    details.dataset.state='success';
  }catch(error){
    details.textContent=String(error?.message??error);
    details.dataset.state='error';
  }
  switchButton.hidden=true;
  timer=setTimeout(()=>void dismiss(),4500);
});

document.getElementById('suggestionClose').addEventListener('click',()=>void dismiss());
systemScheme.addEventListener('change',refreshAppearance);
refreshAppearance();
