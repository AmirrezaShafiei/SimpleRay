import {parseShareLink,parseImport,parseSubscriptionPayload,validateSubscriptionUrl} from './config.js';
import {outboundFromShareLink} from './xray-config.js';

export const STORAGE_KEY='simpleray.configurations.v2';
const VERSION=2;
const REFRESH_HOURS = [0, 6, 24];
const HOUR_MS = 3_600_000;

function validateRefreshHours(hours) {
  if (!REFRESH_HOURS.includes(hours)) throw new Error('Invalid subscription refresh interval');
  return hours;
}
export const MAX_PINNED_SERVERS=3;
const clone=value=>JSON.parse(JSON.stringify(value));
const fresh=()=>({version:VERSION,servers:[],subscriptions:[],selectedId:null});
function id(){return globalThis.crypto?.randomUUID?.()||`local-${Date.now()}-${Math.random().toString(36).slice(2)}`}
function sanitizedName(name,defaultName='Untitled'){
  const value=String(name??'').trim().slice(0,160);
  if(!value && !defaultName)throw new Error('A name is required');
  return value||defaultName;
}
function sourceOf(s,subscriptions){
  if(!s.subscriptionId)return '—';
  return subscriptions.find(x=>x.id===s.subscriptionId)?.name||'—';
}
function endpointKey(value) {
  return JSON.stringify(value, (_key, child) => {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      return Object.fromEntries(Object.keys(child).sort().map(name => [name, child[name]]));
    }
    return child;
  });
}
function checkDocument(value){
  if(!value||value.version!==VERSION||!Array.isArray(value.servers)||!Array.isArray(value.subscriptions))throw new Error('Invalid saved configuration database');
  if(value.servers.length>15000||value.subscriptions.length>1000)throw new Error('Saved configuration database is too large');
  return value;
}
export function createRepository(storage,{idFactory=id}={}){
  let database;
  let loadError=null;
  try{const raw=storage.getItem(STORAGE_KEY);database=raw?checkDocument(JSON.parse(raw)):fresh()}
  catch{database=fresh();loadError='Saved configurations could not be loaded; the original data has not been overwritten.'}
  const snapshot=()=>clone(database);
  const rows=()=>database.servers.map(s=>({...clone(s),source:sourceOf(s,database.subscriptions)}));
  const save=next=>{
    if(loadError)throw new Error('Storage is read-only because the saved database needs recovery');
    next.version=VERSION;
    try{storage.setItem(STORAGE_KEY,JSON.stringify(next))}
    catch{throw new Error('Unable to save configurations. Existing entries were not changed.')}
    database=next;return snapshot();
  };
  const transact=change=>{const next=snapshot();change(next);return save(next)};
  const appendManual=({uri,name})=>{
    const parsed=parseShareLink(uri);
    return transact(next=>{
      if(next.servers.some(s=>!s.subscriptionId&&s.uri===parsed.uri))return;
      next.servers.push({...parsed,name:sanitizedName(name,parsed.name),id:idFactory(),subscriptionId:null});
      if(!next.selectedId)next.selectedId=next.servers.at(-1).id;
    });
  };
  return {
    get loadError(){return loadError},
    snapshot,rows,
    setSelected(serverId){return transact(next=>{if(!next.servers.some(s=>s.id===serverId))throw new Error('Server not found');next.selectedId=serverId})},
    renameServer(serverId, name){
      const displayName = sanitizedName(name, '');
      return transact(next=>{
        const server = next.servers.find(row=>row.id===serverId);
        if(!server)throw new Error('Server not found');
        server.name = displayName;
        if(server.subscriptionId)server.localName = displayName;
      });
    },
    toggleFavorite(serverId){return transact(next=>{const s=next.servers.find(x=>x.id===serverId);if(!s)throw new Error('Server not found');s.favorite=!s.favorite})},
    togglePin(serverId){
      return transact(next=>{
        const server=next.servers.find(row=>row.id===serverId);
        if(!server)throw new Error('Server not found');
        if(!server.pinned&&next.servers.filter(row=>row.pinned).length>=MAX_PINNED_SERVERS){
          throw new Error('Up to 3 servers can be pinned. Unpin one first.');
        }
        server.pinned=!server.pinned;
      });
    },
    receiveFromPhone(text){
      const parsed=parseShareLink(text);
      const outbound=outboundFromShareLink(parsed.uri);
      const key=endpointKey(outbound);
      const existing=database.servers.find(server=>{
        if(server.type!==parsed.type||server.port!==parsed.port||server.host?.toLowerCase()!==parsed.host.toLowerCase())return false;
        try{return endpointKey(outboundFromShareLink(server.uri))===key}
        catch{return false}
      });
      // Receive the existing record as-is, including pins, source and test history.
      if(existing)return {id:existing.id,duplicate:true,outbound};
      const serverId=idFactory();
      transact(next=>{
        next.servers.push({...parsed,id:serverId,subscriptionId:null});
        if(!next.selectedId)next.selectedId=serverId;
      });
      return {id:serverId,duplicate:false,outbound};
    },
    setLatency(serverId,{latency,latencyStatus,latencySuccess,latencyAttempted}){
      if(latency!==null && (!Number.isInteger(latency)||latency<0||latency>999999))throw new Error('Invalid latency value');
      return transact(next=>{
        const s=next.servers.find(x=>x.id===serverId);
        if(!s)throw new Error('Server not found');
        s.latency=latency;
        s.latencyStatus=String(latencyStatus||'unknown').slice(0,20);
        s.latencySuccess=Number(latencySuccess)||0;
        s.latencyAttempted=Number(latencyAttempted)||0;
      });
    },
    importManual(text){
      const result=parseImport(text);
      if(result.servers.length){transact(next=>{
        const existing=new Set(next.servers.filter(x=>!x.subscriptionId).map(x=>x.uri));
        for(const s of result.servers){if(existing.has(s.uri))continue;next.servers.push({...s,id:idFactory(),subscriptionId:null});existing.add(s.uri)}
        if(!next.selectedId&&next.servers.length)next.selectedId=next.servers[0].id;
      })}
      return result;
    },
    addManual:appendManual,
    updateManual(serverId,uri,name){
      const parsed=parseShareLink(uri);
      return transact(next=>{
        const s=next.servers.find(x=>x.id===serverId);if(!s)throw new Error('Server not found');
        if(s.subscriptionId)throw new Error('Subscription nodes cannot be edited directly; duplicate them as manual first');
        if(next.servers.some(x=>x.id!==serverId&&!x.subscriptionId&&x.uri===parsed.uri))throw new Error('This manual configuration already exists');
        const displayName=sanitizedName(name,parsed.name);
        if(s.signature===parsed.signature){
          Object.assign(s,{uri:parsed.uri,name:displayName});
        }else{
          Object.assign(s,parsed,{name:displayName,favorite:s.favorite,latencyStatus:'unknown',latencySuccess:0,latencyAttempted:0});
        }
      });
    },
    duplicateManual(serverId){
      return transact(next=>{
        const source=next.servers.find(s=>s.id===serverId);if(!source)throw new Error('Server not found');
        const duplicate={...clone(source),id:idFactory(),name:sanitizedName(source.name)+' (copy)',favorite:false,pinned:false,subscriptionId:null,latency:null,latencyStatus:'unknown',latencySuccess:0,latencyAttempted:0};
        delete duplicate.localName;
        next.servers.push(duplicate);next.selectedId=duplicate.id;
      });
    },
    deleteServer(serverId){
      return transact(next=>{
        const found=next.servers.find(x=>x.id===serverId);if(!found)throw new Error('Server not found');
        if(found.subscriptionId){
          const sub=next.subscriptions.find(s=>s.id===found.subscriptionId);
          if(sub&&!sub.hiddenSignatures.includes(found.signature))sub.hiddenSignatures.push(found.signature);
        }
        next.servers=next.servers.filter(x=>x.id!==serverId);
        if(next.selectedId===serverId)next.selectedId=next.servers[0]?.id??null;
      });
    },
    addSubscription(name,url,autoRefreshHours=0){
      const cleanedName=sanitizedName(name,'');const cleanedUrl=validateSubscriptionUrl(url);
      validateRefreshHours(autoRefreshHours);
      let created;
      transact(next=>{
        if(next.subscriptions.some(s=>s.url===cleanedUrl))throw new Error('This subscription URL is already saved');
        created={id:idFactory(),name:cleanedName,url:cleanedUrl,autoRefreshHours,updatedAt:null,lastAttemptAt:null,lastError:null,hiddenSignatures:[]};
        next.subscriptions.push(created);
      });
      return clone(created);
    },
    editSubscription(subscriptionId, {name, url, autoRefreshHours=0}) {
      const cleanedName = sanitizedName(name, '');
      const cleanedUrl = validateSubscriptionUrl(url);
      validateRefreshHours(autoRefreshHours);
      let result;
      transact(next => {
        const subscription = next.subscriptions.find(item => item.id === subscriptionId);
        if (!subscription) throw new Error('Subscription not found');
        if (next.subscriptions.some(item => item.id !== subscriptionId && item.url === cleanedUrl)) {
          throw new Error('This subscription URL is already saved');
        }
        const urlChanged = subscription.url !== cleanedUrl;
        Object.assign(subscription, {name:cleanedName, url:cleanedUrl, autoRefreshHours});
        result = {subscription:clone(subscription), urlChanged};
      });
      return result;
    },
    dueSubscriptions(now=Date.now()) {
      return database.subscriptions.filter(subscription => {
        const hours = subscription.autoRefreshHours;
        if (!hours || !REFRESH_HOURS.includes(hours)) return false;
        const lastAttempt = Date.parse(subscription.lastAttemptAt ?? subscription.updatedAt ?? '');
        return !Number.isFinite(lastAttempt) || now - lastAttempt >= hours * HOUR_MS;
      }).map(clone);
    },
    renameSubscription(subscriptionId,name){
      const cleanedName=sanitizedName(name,'');
      return transact(next=>{const s=next.subscriptions.find(s=>s.id===subscriptionId);if(!s)throw new Error('Subscription not found');s.name=cleanedName});
    },
    setSubscriptionError(subscriptionId,message,attemptedAt=new Date().toISOString()){
      return transact(next=>{
        const subscription=next.subscriptions.find(s=>s.id===subscriptionId);
        if(!subscription)throw new Error('Subscription not found');
        subscription.lastError=String(message).slice(0,180);
        subscription.lastAttemptAt=attemptedAt;
      });
    },
    refreshSubscription(subscriptionId,payload,updatedAt=new Date().toISOString()){
      const parsed=parseSubscriptionPayload(payload);let added=0,removed=0,retained=0;
      transact(next=>{
        const subscription=next.subscriptions.find(s=>s.id===subscriptionId);
        if(!subscription)throw new Error('Subscription not found');
        const previous=next.servers.filter(s=>s.subscriptionId===subscriptionId);
        const existing=new Map(previous.map(s=>[s.signature,s]));
        const imported=new Map();
        for(const data of parsed.servers){
          if(subscription.hiddenSignatures.includes(data.signature)||imported.has(data.signature))continue;
          const old=existing.get(data.signature);
          const server={...data,id:old?.id||idFactory(),subscriptionId,favorite:old?.favorite||false,pinned:old?.pinned||false,latency:old?.latency??null,latencyStatus:old?.latencyStatus||'unknown',latencySuccess:old?.latencySuccess||0,latencyAttempted:old?.latencyAttempted||0};
          if(old?.localName){
            server.localName=old.localName;
            server.name=old.localName;
          }
          imported.set(data.signature,server);
          if(old)retained++;else added++;
        }
        removed=previous.filter(s=>!imported.has(s.signature)).length;
        next.servers=next.servers.filter(s=>s.subscriptionId!==subscriptionId).concat([...imported.values()]);
        subscription.updatedAt=updatedAt;subscription.lastAttemptAt=updatedAt;subscription.lastError=null;
        if(!next.servers.some(s=>s.id===next.selectedId))next.selectedId=next.servers[0]?.id??null;
      });
      return {added,removed,retained,invalid:parsed.errors.length};
    },
    deleteSubscription(subscriptionId,{keepNodes=false}={}){
      return transact(next=>{
        const sub=next.subscriptions.find(s=>s.id===subscriptionId);if(!sub)throw new Error('Subscription not found');
        next.subscriptions=next.subscriptions.filter(s=>s.id!==subscriptionId);
        if(keepNodes){for(const server of next.servers){if(server.subscriptionId===subscriptionId)server.subscriptionId=null}}
        else next.servers=next.servers.filter(s=>s.subscriptionId!==subscriptionId);
        if(!next.servers.some(s=>s.id===next.selectedId))next.selectedId=next.servers[0]?.id??null;
      });
    },
  };
}
