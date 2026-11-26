/** Phase 1 demo records. Never represent these as live/configured servers. */
export const DEMO_SERVERS = Object.freeze([
  {id:'demo-de',flag:'🇩🇪',name:'Germany 01',type:'VMess',latency:68,source:'Daily Nodes',favorite:true},
  {id:'demo-nl',flag:'🇳🇱',name:'Netherlands 02',type:'VLESS',latency:92,source:'Daily Nodes',favorite:false},
  {id:'demo-fr',flag:'🇫🇷',name:'France 01',type:'Trojan',latency:104,source:'—',favorite:false},
  {id:'demo-tr',flag:'🇹🇷',name:'Turkey 01',type:'VMess',latency:138,source:'Daily Nodes',favorite:false},
  {id:'demo-us',flag:'🇺🇸',name:'USA 01',type:'VLESS',latency:211,source:'Backup Sub',favorite:false},
  {id:'demo-sg',flag:'🇸🇬',name:'Singapore 01',type:'Shadowsocks',latency:236,source:'—',favorite:false},
  {id:'demo-jp',flag:'🇯🇵',name:'Japan 01',type:'VMess',latency:289,source:'Daily Nodes',favorite:false},
]);
export const SORT_COLUMNS = Object.freeze(['favorite','name','type','latency','source']);
export function filterServers(servers,query='') {
  const term=query.trim().toLocaleLowerCase();
  if(!term)return [...servers];
  return servers.filter(s=>[s.name,s.type,s.source].some(v=>String(v).toLocaleLowerCase().includes(term)));
}
const serverCollator = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});
export function sortServers(servers,key,direction='asc') {
  const sign=direction==='desc'?-1:1;
  const hasSort = SORT_COLUMNS.includes(key);
  return servers.map((server,i)=>({server,i})).sort((a,b)=>{
    const pinOrder=Number(Boolean(b.server.pinned))-Number(Boolean(a.server.pinned));
    if(pinOrder)return pinOrder;
    if(!hasSort)return a.i-b.i;
    const av=a.server[key],bv=b.server[key];
    if(key==='latency'){
      const am=typeof av!=='number'||!Number.isFinite(av),bm=typeof bv!=='number'||!Number.isFinite(bv);
      if(am!==bm)return am?1:-1; // unknown latency last in BOTH directions
      if(am&&bm)return a.i-b.i;
      return (av-bv)*sign||a.i-b.i;
    }
    let cmp;
    if(key==='favorite')cmp=Number(av)-Number(bv);
    else cmp=serverCollator.compare(String(av??''), String(bv??''));
    return cmp*sign||a.i-b.i;
  }).map(x=>x.server);
}
export function latencyClass(value){
  if(typeof value!=='number'||!Number.isFinite(value))return 'latency-unknown';
  if(value<=200)return 'latency-good';
  if(value<=400)return 'latency-ok';
  if(value<=800)return 'latency-slow';
  return 'latency-bad';
}

export function stabilityLevel(successes,attempts){
  if(!Number.isFinite(successes)||!Number.isFinite(attempts)||attempts<=0)return 'unknown';
  const ratio=successes/attempts;
  if(ratio>=0.9)return 'stable';
  if(ratio>=0.7)return 'fair';
  if(ratio>=0.4)return 'unstable';
  return 'poor';
}
