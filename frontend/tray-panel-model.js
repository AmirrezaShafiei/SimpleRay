import {filterServers,sortServers} from './model.js';

export function trayServers(servers, {group='all', query='', suggestion=null}={}) {
  const grouped=group==='all'?servers:servers.filter(server=>{
    if(group==='pinned')return server.pinned;
    if(group==='favorites')return server.favorite;
    return group===`subscription:${server.subscriptionId}`;
  });
  const results=sortServers(filterServers(grouped,query),null);
  const suggested=results.findIndex(server=>server.id===suggestion?.serverId);
  if(suggested>0)results.unshift(results.splice(suggested,1)[0]);
  return results;
}

export function trayConnectionAction(snapshot) {
  if(snapshot.proxyInactive)return {action:'restoreProxy',serverId:null,label:'Restore proxy',primary:true};
  if(snapshot.retry&&snapshot.activeId)return {action:'retry',serverId:snapshot.activeId,label:'Retry',primary:true};
  if(snapshot.connected||snapshot.activeId)return {action:'disconnect',serverId:null,label:'Disconnect',primary:false};
  return {action:'connect',serverId:snapshot.serverId??null,label:'Connect',primary:true};
}

export function outageLabel(seconds) {
  if(seconds<60)return `${seconds} s`;
  const minutes=Math.floor(seconds/60);
  if(minutes<60)return `${minutes}m ${seconds%60}s`;
  return `${Math.floor(minutes/60)}h ${minutes%60}m`;
}
