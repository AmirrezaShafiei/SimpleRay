import {parseShareLink,parseImport,parseSubscriptionPayload,validateSubscriptionUrl} from './config.js';

export const STORAGE_KEY='simpleray.configurations.v2';
const VERSION=2;
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
    toggleFavorite(serverId){return transact(next=>{const s=next.servers.find(x=>x.id===serverId);if(!s)throw new Error('Server not found');s.favorite=!s.favorite})},
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
        Object.assign(s,parsed,{id:serverId,name:sanitizedName(name,parsed.name),favorite:s.favorite,subscriptionId:null});
      });
    },
    duplicateManual(serverId){
      return transact(next=>{
        const source=next.servers.find(s=>s.id===serverId);if(!source)throw new Error('Server not found');
        const duplicate={...clone(source),id:idFactory(),name:sanitizedName(source.name)+' (copy)',favorite:false,subscriptionId:null,latency:null};
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
    addSubscription(name,url){
      const cleanedName=sanitizedName(name,'');const cleanedUrl=validateSubscriptionUrl(url);
      let created;
      transact(next=>{
        if(next.subscriptions.some(s=>s.url===cleanedUrl))throw new Error('This subscription URL is already saved');
        created={id:idFactory(),name:cleanedName,url:cleanedUrl,updatedAt:null,lastError:null,hiddenSignatures:[]};
        next.subscriptions.push(created);
      });
      return clone(created);
    },
    renameSubscription(subscriptionId,name){
      const cleanedName=sanitizedName(name,'');
      return transact(next=>{const s=next.subscriptions.find(s=>s.id===subscriptionId);if(!s)throw new Error('Subscription not found');s.name=cleanedName});
    },
    setSubscriptionError(subscriptionId,message){
      return transact(next=>{const s=next.subscriptions.find(s=>s.id===subscriptionId);if(!s)throw new Error('Subscription not found');s.lastError=String(message).slice(0,180)});
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
          const server={...data,id:old?.id||idFactory(),subscriptionId,favorite:old?.favorite||false,latency:old?.latency??null};
          imported.set(data.signature,server);
          if(old)retained++;else added++;
        }
        removed=previous.filter(s=>!imported.has(s.signature)).length;
        next.servers=next.servers.filter(s=>s.subscriptionId!==subscriptionId).concat([...imported.values()]);
        subscription.updatedAt=updatedAt;subscription.lastError=null;
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
