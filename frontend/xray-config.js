/**
 * Converts imported share links into restricted Xray outbound objects.
 * No secrets are logged or reflected into errors. Reject unknown transport/security
 * combinations rather than silently connecting with wrong TLS/REALITY settings.
 * See https://xtls.github.io/en/config/transport.html
 */
import {parseShareLink} from './config.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URI_LENGTH=16384;
const allowedFingerprints=new Set(['chrome','firefox','safari','ios','android','edge','360','qq','random','randomized','']);
function unsupported(label){throw new Error(`Unsupported Xray profile option: ${label}`)}
function invalid(label){throw new Error(`Invalid Xray profile: ${label}`)}
function text(v){return String(v??'').trim()}
function decode(v){try{return decodeURIComponent(v)}catch{invalid('malformed percent encoding')}}
function requireText(value,label){const s=text(value);if(!s)invalid(label);return s}
function reqPort(v){const s=String(v??'');const n=Number(s);if(!/^\d{1,5}$/.test(s)||!Number.isInteger(n)||n<1||n>65535)invalid('port');return n}
function reqUUID(v){if(!UUID.test(v))invalid('UUID');return v}
function reqHost(v){const s=text(v);if(!s||s.length>253||/[\s\/\\?#@]/.test(s))invalid('server hostname');return s}
function decodeBase64(s){
  const v=text(s).replace(/-/g,'+').replace(/_/g,'/');if(!v||/[^A-Za-z0-9+/=]/.test(v)||v.length%4===1)invalid('base64');
  const v2=v+'='.repeat((4-v.length%4)%4);
  try{const binary=atob(v2);return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(binary,c=>c.charCodeAt(0)))}catch{invalid('base64 UTF-8')}
}
function query(url,key,alt=''){return text(url.searchParams.get(key)??alt)}
function normalizeTransport(raw, source, defaults={}){
  const net=text(raw||'tcp').toLowerCase();
  const network=net==='tcp'||net==='raw'?'raw':net==='ws'?'ws':net==='grpc'?'grpc':net==='httpupgrade'?'httpupgrade':net==='xhttp'?'xhttp':null;
  if(!network)unsupported('network '+net);
  const stream={network};
  if(network==='ws'){
    const path=source.path||'/';const host=source.host||'';
    stream.wsSettings={path:String(path).startsWith('/')?path:'/'+path};
    if(host)stream.wsSettings.headers={Host:host};
  }
  if(network==='grpc'){
    stream.grpcSettings={serviceName:source.serviceName||''};
    if(source.mode&&source.mode!=='gun'&&source.mode!=='multi')unsupported('gRPC mode');
    if(source.mode==='multi')stream.grpcSettings.multiMode=true;
  }
  if(network==='httpupgrade'){
    stream.httpupgradeSettings={path:source.path||'/'};
    if(source.host)stream.httpupgradeSettings.host=source.host;
  }
  if(network==='xhttp'){
    stream.xhttpSettings={path:source.path||'/'};
    if(source.host)stream.xhttpSettings.host=source.host;
    if(source.mode){
      if(!['auto','packet-up','stream-up','stream-one'].includes(source.mode))unsupported('XHTTP mode');
      stream.xhttpSettings.mode=source.mode;
    }
    if(source.extra){
      let extra;try{extra=JSON.parse(source.extra)}catch{invalid('XHTTP extra JSON')}
      if(!extra||typeof extra!=='object'||Array.isArray(extra))invalid('XHTTP extra JSON');
      stream.xhttpSettings.extra=extra;
    }
  }
  const sec=text(defaults.security||'none').toLowerCase();
  if(!['none','tls','reality'].includes(sec))unsupported('security '+sec);
  stream.security=sec;
  const serverName=defaults.sni||defaults.address;
  const fingerprint=text(defaults.fingerprint);
  if(fingerprint&&!allowedFingerprints.has(fingerprint))unsupported('fingerprint');
  const alpn=defaults.alpn?String(defaults.alpn).split(',').map(x=>x.trim()).filter(Boolean):[];
  if(sec==='tls'){
    stream.tlsSettings={serverName:String(serverName||'')};
    if(alpn.length)stream.tlsSettings.alpn=alpn;
    if(fingerprint)stream.tlsSettings.fingerprint=fingerprint;
  }
  if(sec==='reality'){
    const publicKey=requireText(defaults.publicKey,'REALITY public key');
    if(!serverName)invalid('REALITY SNI');
    const shortId=text(defaults.shortId);
    if(shortId.length>16||shortId.length%2!==0||/[^0-9a-f]/i.test(shortId))invalid('REALITY short ID');
    if(!['raw','grpc','xhttp'].includes(network))unsupported('REALITY with '+network);
    stream.realitySettings={serverName:String(serverName),fingerprint:fingerprint||'chrome',password:publicKey,shortId,spiderX:defaults.spiderX||'/'};
  }
  return stream;
}
function fromURL(uri,protocol){
  let u;try{u=new URL(uri)}catch{invalid('URL')}
  const address=reqHost(u.hostname),port=reqPort(u.port),username=decode(u.username);
  const q=k=>query(u,k);
  const security=q('security')|| (protocol==='trojan'?'tls':'none');
  const streamSettings=normalizeTransport(q('type')||'tcp',{
    host:q('host'),path:q('path')||'/',serviceName:q('serviceName'),mode:q('mode'),extra:q('extra')
  },{
    security,address,sni:q('sni')||q('serverName')||q('peer'),
    fingerprint:q('fp'),alpn:q('alpn'),publicKey:q('pbk'),shortId:q('sid'),spiderX:q('spx')||'/'
  });
  if(protocol==='vless'){
    const encryption=q('encryption')||'none';if(encryption!=='none')unsupported('VLESS encryption');
    const user={id:reqUUID(username),encryption};if(q('flow'))user.flow=q('flow');
    return {tag:'proxy',protocol,settings:{vnext:[{address,port,users:[user]}]},streamSettings};
  }
  if(protocol==='trojan'){
    const password=requireText(username,'Trojan password');
    return {tag:'proxy',protocol,settings:{servers:[{address,port,password}]},streamSettings};
  }
  invalid('protocol');
}
function vmess(uri){
  let v;try{v=JSON.parse(decodeBase64(uri.slice(8).split('#')[0].split('?')[0]))}catch{invalid('VMess JSON')}
  if(!v||typeof v!=='object'||Array.isArray(v))invalid('VMess JSON');
  const address=reqHost(v.add),port=reqPort(v.port);
  const user={id:reqUUID(String(v.id||'')),alterId:Number(v.aid||0),security:text(v.scy||'auto')};
  if(!Number.isInteger(user.alterId)||user.alterId<0)invalid('VMess alterId');
  const tlsMode=text(v.tls).toLowerCase();
  if(tlsMode&&!['tls','reality','none'].includes(tlsMode))unsupported('VMess TLS mode');
  const streamSettings=normalizeTransport(v.net||'tcp',{
    path:text(v.path)||'/',host:text(v.host),serviceName:text(v.path)||'',mode:'',extra:text(v.extra)
  },{security:tlsMode==='tls'?'tls':tlsMode==='reality'?'reality':'none',address,sni:v.sni,fingerprint:v.fp,alpn:v.alpn,publicKey:v.pbk,shortId:v.sid,spiderX:v.spx});
  if(v.type&&v.type!=='none')unsupported('VMess header type');
  return {tag:'proxy',protocol:'vmess',settings:{vnext:[{address,port,users:[user]}]},streamSettings};
}
function shadowsocks(uri){
  const noFragment=uri.slice(5).split('#')[0];
  const [core,queryPart='']=noFragment.split('?');
  if(queryPart)unsupported('Shadowsocks plugins or URI parameters');
  let auth,endpoint;
  if(core.includes('@')){
    const i=core.lastIndexOf('@');auth=core.slice(0,i);endpoint=core.slice(i+1);
    if(!auth.includes(':'))auth=decodeBase64(auth);
  }else{
    const decoded=decodeBase64(core),i=decoded.lastIndexOf('@');if(i<0)invalid('Shadowsocks address');
    auth=decoded.slice(0,i);endpoint=decoded.slice(i+1);
  }
  const idx=auth.indexOf(':');if(idx<1)invalid('Shadowsocks credentials');
  const method=decode(auth.slice(0,idx));const password=decode(auth.slice(idx+1));
  if(!password)invalid('Shadowsocks password');
  let u;try{u=new URL('http://'+endpoint)}catch{invalid('Shadowsocks host')}
  const address=reqHost(u.hostname),port=reqPort(u.port);
  // Xray-supported methods may change: core's own -test validates at launch.
  return {tag:'proxy',protocol:'shadowsocks',settings:{servers:[{address,port,method,password}]}};
}
export function outboundFromShareLink(uri){
  const raw=String(uri??'').trim();if(!raw||raw.length>MAX_URI_LENGTH)invalid('link length');
  parseShareLink(raw); // Reuse Phase-2 canonical validation.
  if(/^vless:\/\//i.test(raw))return fromURL(raw,'vless');
  if(/^trojan:\/\//i.test(raw))return fromURL(raw,'trojan');
  if(/^vmess:\/\//i.test(raw))return vmess(raw);
  if(/^ss:\/\//i.test(raw))return shadowsocks(raw);
  unsupported('protocol');
}
/** Used only for test/diagnostic output. No URLs/credentials included. */
export function outboundSummary(profile){return {protocol:profile.protocol,transport:profile.streamSettings?.network||'raw',security:profile.streamSettings?.security||'none'}};
