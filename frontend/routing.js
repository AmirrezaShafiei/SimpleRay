const $=id=>document.getElementById(id);
const empty=()=>({mode:'systemProxy',apps:[],sites:[]});
const message=error=>error instanceof Error?error.message:String(error);

const domainKey=domain=>domain.replace(/^\./,'');
const domainError='Enter a website address such as example.com, https://example.com, or .ir.';

export function normalizeWebsiteRule(input){
  const value=input.trim();
  const isUrl=/^https?:\/\/[^/]/i.test(value);
  const suffix=value.startsWith('.');
  const text=domainKey(value);
  if(!text||(!isUrl&&/[\s/\\@:#?*%]/.test(text)))throw new Error(domainError);
  let url;
  try{url=new URL(isUrl?value:`https://${text}`)}
  catch{throw new Error(domainError)}
  const domain=url.hostname.replace(/\.$/,'');
  if(url.username||url.password||domain.length>253||(!suffix&&!domain.includes('.'))||
    /^\d+(?:\.\d+){3}$/.test(domain)||
    domain.split('.').some(label=>!(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))){
    throw new Error(domainError);
  }
  return suffix?`.${domain}`:domain;
}

export function matchWebsiteRule(domain,sites){
  let best;
  for(const entry of sites){
    const key=domainKey(entry.domain);
    if((domain===key||domain.endsWith(`.${key}`))&&(!best||key.length>domainKey(best.domain).length)){
      best=entry;
    }
  }
  return best;
}

export function createRoutingEditor({invoke,showDialog,nativeHost,onSaved}){
  let settings=empty();
  const error=$('routingError');
  const siteInput=$('siteRouteDomain');
  const siteList=$('siteRouteList');
  const siteFeedback=$('siteRouteFeedback');
  function buttons(route,update){
    const select=document.createElement('select');
    select.setAttribute('aria-label','Route');
    for(const [value,label] of [['direct','Direct'],['proxy','Through tunnel']])select.add(new Option(label,value));
    select.value=route;
    select.addEventListener('change',()=>update(select.value));
    return select;
  }
  function row(label){
    const li=document.createElement('li'),title=document.createElement('span');
    title.textContent=label;title.title=label;
    li.append(title);
    return li;
  }
  function removeButton(remove){
    const button=document.createElement('button');
    button.type='button';button.className='dialog-action';button.textContent='Remove';
    button.addEventListener('click',()=>{remove();render()});
    return button;
  }
  function render(){
    $('routeMode').value=settings.mode;
    $('appRouteList').replaceChildren(...settings.apps.map((entry,i)=>{
      const li=row(entry.path.split(/[\\/]/).at(-1));
      li.firstChild.title=entry.path;
      const lock=document.createElement('label');
      const check=document.createElement('input');check.type='checkbox';
      check.checked=entry.locked;
      check.disabled=settings.mode!=='tun'||entry.route!=='proxy';
      check.addEventListener('change',()=>{entry.locked=check.checked});
      lock.append(check,' Tunnel lock');
      li.append(buttons(entry.route,route=>{
        entry.route=route;
        if(route==='direct')entry.locked=false;
        render();
      }),lock,removeButton(()=>settings.apps.splice(i,1)));
      return li;
    }));
    siteList.replaceChildren(...settings.sites.map((entry,i)=>{
      const li=row(entry.domain);
      li.append(buttons(entry.route,route=>{
        entry.route=route;
        siteFeedback.textContent='';
      }),removeButton(()=>{
        settings.sites.splice(i,1);
        siteFeedback.textContent='';
      }));
      return li;
    }));
  }
  $('routeMode').addEventListener('change',()=>{
    settings.mode=$('routeMode').value;
    render();
  });
  $('appRouteForm').addEventListener('submit',event=>{
    event.preventDefault();
    const path=$('appRoutePath').value.trim();
    if(settings.apps.some(entry=>entry.path.toLowerCase()===path.toLowerCase()))return;
    settings.apps.push({path,route:'proxy',locked:false});
    $('appRoutePath').value='';
    render();
  });
  $('browseRouteApp').addEventListener('click',async()=>{
    try{const path=await invoke('choose_routing_app');if(path)$('appRoutePath').value=path}
    catch(failure){error.textContent=message(failure)}
  });
  $('siteRouteForm').addEventListener('submit',event=>{
    event.preventDefault();
    const checking=event.submitter?.id==='checkSiteRoute';
    let domain;
    try{domain=normalizeWebsiteRule(siteInput.value)}
    catch(failure){siteFeedback.textContent=message(failure);return}
    if(checking){
      if(domain.startsWith('.')){
        siteFeedback.textContent='Enter a specific website to check its route.';
        return;
      }
      const rule=matchWebsiteRule(domain,settings.sites);
      const route=rule?.route==='direct'?'Direct':'Through tunnel';
      siteFeedback.textContent=rule?`${route} · Matches ${rule.domain}`:`${route} · Default website route`;
      return;
    }
    const existing=settings.sites.findIndex(entry=>domainKey(entry.domain)===domainKey(domain));
    if(existing!==-1){
      siteFeedback.textContent=`${settings.sites[existing].domain} already has a rule. Change its route in the list.`;
      const row=siteList.children[existing];
      row.querySelector('select').focus();
      row.scrollIntoView({block:'nearest'});
      return;
    }
    settings.sites.push({domain,route:$('siteRouteChoice').value});
    siteInput.value='';
    siteFeedback.textContent='';
    render();
  });
  siteInput.addEventListener('input',()=>{siteFeedback.textContent=''});
  $('saveRouting').addEventListener('click',async()=>{
    const save=$('saveRouting');
    save.disabled=true;error.textContent='';
    try{
      const changed=await invoke('set_routing_settings',{settings});
      $('routingDialog').close();await onSaved(changed);
    }catch(failure){error.textContent=message(failure)}
    finally{save.disabled=false}
  });
  return {async open(){
    if(!nativeHost())return;
    error.textContent='';
    $('appRoutePath').value='';siteInput.value='';siteFeedback.textContent='';
    showDialog('routingDialog');
    try{settings=await invoke('get_routing_settings');render()}
    catch(failure){error.textContent=message(failure)}
  }};
}
export function renderIpHistory(list,entries){
  list.replaceChildren();
  if(!entries.length){const row=document.createElement('li');row.textContent='No exit IP recorded yet.';list.append(row);return}
  for(const entry of entries.slice().reverse()){
    const row=document.createElement('li'),ip=document.createElement('strong'),date=document.createElement('time');
    ip.textContent=entry.ip;date.textContent=new Date(entry.observedAtMs).toLocaleString();
    row.append(ip,date);list.append(row);
  }
}
