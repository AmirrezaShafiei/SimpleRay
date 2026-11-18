/**
 * SimpleRay share-link parser. No network, DOM or storage dependencies.
 * These imported records are not an assertion that Xray-core can connect yet.
 */
export const PROTOCOLS=Object.freeze(['VMess','VLESS','Trojan','Shadowsocks']);
const MAX_IMPORT_CHARS=2_000_000;
const MAX_LINES=3000;
const SUB_PREFIX=/^https?:\/\//i;
const URI_PREFIX=/^(?:vmess|vless|trojan|ss):\/\//i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(reason){throw new Error(reason)}
function decodeBase64(s){
  const value=s.trim().replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
  if(!value || /[^A-Za-z0-9+/=]/.test(value) || value.length%4===1)fail('Invalid base64 encoding');
  const padded=value+'='.repeat((4-value.length%4)%4);
  try{
    if(typeof atob==='function'){
      const binary=atob(padded);const bytes=Uint8Array.from(binary,ch=>ch.charCodeAt(0));
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }
    return Buffer.from(padded,'base64').toString('utf8');
  }catch{fail('Invalid base64 or UTF-8 data')}
}
function requirePort(value){const n=Number(value);if(!/^\d{1,5}$/.test(String(value)) || !Number.isInteger(n) || n<1 || n>65535)fail('Invalid server port');return n}
function requireHost(value){const host=String(value??'').trim();if(!host || host.length>253 || /[\s\/\\?#@]/.test(host))fail('Invalid server host');return host}
function label(value,backup){try{const s=decodeURIComponent(String(value??'').replace(/\+/g,'%20')).trim();return (s||backup).slice(0,160)}catch{return backup}}
function identify(raw){let hash=2166136261;for(let i=0;i<raw.length;i++){hash^=raw.charCodeAt(i);hash=Math.imul(hash,16777619)}return (hash>>>0).toString(16).padStart(8,'0')}
function details(record,uri,uniqueString){return {...record,uri,signature:identify(uniqueString),latency:null,flag:'🌐',favorite:false}}
function parseVmess(uri){
  const payload=uri.slice(8).split('#')[0].split('?')[0];
  let v;try{v=JSON.parse(decodeBase64(payload))}catch{fail('Invalid VMess JSON or base64 data')}
  if(!v || typeof v!=='object'||Array.isArray(v))fail('Invalid VMess profile');
  const host=requireHost(v.add),port=requirePort(v.port),id=String(v.id||'');
  if(!UUID.test(id))fail('VMess requires a valid UUID');
  const name=label(v.ps,host);
  const base={name,type:'VMess',host,port};
  // VMess is base64 JSON. Exclude only its display label from identity.
  const stable={...v};delete stable.ps;
  return details(base,uri,'VMess:'+JSON.stringify(Object.keys(stable).sort().map(k=>[k,stable[k]])));
}
function parseURI(url,protocol){
  let u;try{u=new URL(url)}catch{fail('Malformed '+protocol+' URL')}
  const host=requireHost(u.hostname),port=requirePort(u.port);
  const username=decodeURIComponent(u.username||'');
  const fallback=host+':'+port;
  const name=label(u.hash.slice(1),fallback);
  if(protocol==='VLESS'&&!UUID.test(username))fail('VLESS requires a valid UUID');
  if(protocol==='Trojan'&&!username)fail('Trojan password is missing');
  const signature=protocol+':'+u.username+'@'+u.host+u.search;
  return details({name,type:protocol,host,port},url,signature);
}
function parseShadowsocks(uri){
  const body=uri.slice(5);const hashAt=body.indexOf('#');const beforeHash=hashAt>=0?body.slice(0,hashAt):body;
  const namePart=hashAt>=0?body.slice(hashAt+1):'';
  const queryAt=beforeHash.indexOf('?');const core=queryAt>=0?beforeHash.slice(0,queryAt):beforeHash;
  const pluginPart=queryAt>=0?beforeHash.slice(queryAt):'';
  let credentials,endpoint;
  if(core.includes('@')){
    const at=core.lastIndexOf('@');credentials=core.slice(0,at);endpoint=core.slice(at+1);
    if(!credentials.includes(':'))credentials=decodeBase64(credentials);
  }else{
    const decoded=decodeBase64(core);const at=decoded.lastIndexOf('@');if(at<0)fail('Shadowsocks server address is missing');
    credentials=decoded.slice(0,at);endpoint=decoded.slice(at+1);
  }
  const colon=credentials.indexOf(':');
  if(colon<=0||colon===credentials.length-1)fail('Shadowsocks method or password is missing');
  // Credentials may contain encoded characters; preserved verbatim in uri.
  const method=decodeURIComponent(credentials.slice(0,colon));
  if(!/^[\w-]{2,50}$/.test(method))fail('Invalid Shadowsocks cipher name');
  let url;try{url=new URL('ss://'+endpoint)}catch{fail('Invalid Shadowsocks server address')}
  const host=requireHost(url.hostname),port=requirePort(url.port),name=label(namePart,host+':'+port);
  const signature='Shadowsocks:'+credentials+'@'+endpoint+pluginPart;
  return details({name,type:'Shadowsocks',host,port},uri,signature);
}
export function parseShareLink(raw){
  const uri=String(raw??'').trim();if(uri.length>16384)fail('Share link is too long');
  if(/^vmess:\/\//i.test(uri))return parseVmess(uri);
  if(/^vless:\/\//i.test(uri))return parseURI(uri,'VLESS');
  if(/^trojan:\/\//i.test(uri))return parseURI(uri,'Trojan');
  if(/^ss:\/\//i.test(uri))return parseShadowsocks(uri);
  fail('Unsupported share-link scheme');
}
export function validateSubscriptionUrl(value){
  let u;try{u=new URL(String(value||'').trim())}catch{fail('Invalid subscription URL')}
  if(!['https:','http:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.hash)fail('Subscription must be an HTTP(S) URL without embedded userinfo or fragment');
  if(['localhost','127.0.0.1','::1','[::1]'].includes(u.hostname.toLowerCase()))fail('Localhost subscription URLs are not supported');
  if(u.toString().length>8192)fail('Subscription URL is too long');
  return u.toString();
}
function extractLines(input){
  const trimmed=String(input??'').trim();if(!trimmed)return [];
  if(URI_PREFIX.test(trimmed)||SUB_PREFIX.test(trimmed)||/\n/.test(trimmed))return trimmed.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  try{const decoded=decodeBase64(trimmed);if(URI_PREFIX.test(decoded.trim())||/\n/.test(decoded))return decoded.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)}catch{/* report as invalid below */}
  return [trimmed];
}
export function parseImport(input,{allowSubscriptionUrls=true}={}){
  if(typeof input!=='string'||input.length>MAX_IMPORT_CHARS)fail('Import payload is too large');
  const lines=extractLines(input);if(lines.length>MAX_LINES)fail('Too many import entries');
  const servers=[],subscriptionUrls=[],errors=[],seen=new Set();
  for(let i=0;i<lines.length;i++){
    const line=lines[i];if(!line || line.startsWith('#'))continue;
    try{
      if(SUB_PREFIX.test(line)){
        if(!allowSubscriptionUrls)fail('Subscription data must contain proxy links, not another URL');
        const url=validateSubscriptionUrl(line);
        if(!subscriptionUrls.includes(url))subscriptionUrls.push(url);
      }else{
        const item=parseShareLink(line);
        // Deduplicate identical profiles within this import. Different labels remain distinct.
        if(!seen.has(line)){servers.push(item);seen.add(line)}
      }
    }catch(e){errors.push({line:i+1,reason:e.message})} // never echo credentialed input
  }
  return {servers,subscriptionUrls,errors};
}
export function parseSubscriptionPayload(payload){
  const parsed=parseImport(payload,{allowSubscriptionUrls:false});
  if(!parsed.servers.length)fail('Subscription contains no supported configurations');
  return parsed;
}
