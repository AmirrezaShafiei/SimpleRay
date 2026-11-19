// Parse additional profiles into the same restricted single Xray outbound.
const profileError=label=>new Error('Invalid configuration: '+label);
const list=value=>String(value??'').split(',').map(item=>item.trim()).filter(Boolean);
const FIRST_SECTION=/^(?:(?:[ \t]*[#;][^\n]*|[ \t]*)\r?\n)*\s*\[interface\]/i;

export const EXTRA_SCHEMES=/^(?:wireguard|wg|hysteria2|hy2|socks|socks5|socks5h|http-proxy|https-proxy):\/\//i;
export const isWireGuardConfig=value=>FIRST_SECTION.test(value);

function decode(value) {
  try{return decodeURIComponent(value)}catch{throw profileError('malformed percent encoding')}
}

function portNumber(value,min=1,max=65535) {
  if(!/^\d+$/.test(String(value))||Number(value)<min||Number(value)>max){
    throw profileError('port or numeric option out of range');
  }
  return Number(value);
}

function parseUrl(value) {
  let url;
  try{url=new URL(value)}catch{throw profileError('malformed server address')}
  if(!url.hostname||/[\s%/\\@]/.test(url.hostname)||url.pathname&&!['','/'].includes(url.pathname)){
    throw profileError('expected a server endpoint');
  }
  return url;
}

function endpoint(address) {
  const url=parseUrl('endpoint://'+address);
  if(url.username||url.password||url.search||url.hash)throw profileError('invalid WireGuard endpoint');
  return {host:url.hostname,port:portNumber(url.port)};
}

function profile(type,url,port,outbound) {
  const host=url.hostname;
  let name=host+':'+port;
  if(url.hash){
    try{name=decode(url.hash.slice(1)).trim().slice(0,160)||name}catch{/* keep endpoint label */}
  }
  return {name,type,host,port,outbound};
}

function readKey(value,field) {
  const input=String(value??'').trim();
  try {
    if(/^[\da-f]{64}$/i.test(input)){
      return btoa(String.fromCharCode(...input.match(/../g).map(byte=>parseInt(byte,16))));
    }
    if(!/^[\w+/-]{43}=?$/.test(input))throw profileError(field);
    const binary=atob(input.replace(/-/g,'+').replace(/_/g,'/').replace(/=+$/,''));
    if(binary.length!==32)throw profileError(field);
    return btoa(binary);
  } catch { throw profileError(field+' must be a 32-byte WireGuard key'); }
}

function reservedBytes(value) {
  const parts=list(value);
  if(parts.length!==3)throw profileError('WireGuard requires three reserved bytes');
  return parts.map(part=>portNumber(part,0,255));
}

function wirePeer(values) {
  const {host,port}=endpoint(values.endpoint??'');
  const peer={endpoint:host+':'+port,publicKey:readKey(values.publickey,'peer public key')};
  if(values.presharedkey)peer.preSharedKey=readKey(values.presharedkey,'pre-shared key');
  if(values.persistentkeepalive&&values.persistentkeepalive.toLowerCase()!=='off'){
    peer.keepAlive=portNumber(values.persistentkeepalive,0);
  }
  const allowed=list(values.allowedips);
  if(allowed.length)peer.allowedIPs=allowed;
  return peer;
}

function wireOutbound(settings,peers) {
  const outbound={
    tag:'proxy',protocol:'wireguard',
    settings:{secretKey:readKey(settings.privatekey,'private key'),peers,noKernelTun:true}
  };
  const address=list(settings.address);
  const dns=list(settings.dns).filter(value=>/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)||value.includes(':'));
  if(address.length)outbound.settings.address=address;
  if(dns.length)outbound.settings.remoteDNS=dns;
  if(settings.mtu)outbound.settings.mtu=portNumber(settings.mtu,68);
  if(settings.reserved)outbound.settings.reserved=reservedBytes(settings.reserved);
  return outbound;
}

function readQuery(url) {
  const result=Object.create(null);
  for(const field of url.search.slice(1).split('&')){
    const separator=field.indexOf('=');
    if(separator<0)continue;
    result[decode(field.slice(0,separator)).toLowerCase()]=decode(field.slice(separator+1));
  }
  return result;
}

function wireLink(raw) {
  const url=parseUrl(raw);
  const port=portNumber(url.port);
  if(url.password)throw profileError('expected only the WireGuard private key before @');
  const query=readQuery(url);
  const peer=wirePeer({...query,endpoint:url.hostname+':'+port});
  const outbound=wireOutbound({...query,privatekey:decode(url.username)||query.privatekey||query.secretkey},[peer]);
  return profile('WireGuard',url,port,outbound);
}

function wireConf(raw) {
  let section;
  let settings;
  const peers=[];
  for(const rawLine of raw.split(/\r?\n/)){
    const line=rawLine.split(/[#;]/,1)[0].trim();
    if(!line)continue;
    const sectionHeader=line.match(/^\[(interface|peer)\]$/i);
    if(sectionHeader){
      section=Object.create(null);
      if(sectionHeader[1].toLowerCase()==='peer')peers.push(section);
      else{
        if(settings)throw profileError('WireGuard needs one Interface section');
        settings=section;
      }
      continue;
    }
    const separator=line.indexOf('=');
    if(separator<1||!section)throw profileError('malformed WireGuard configuration');
    const key=line.slice(0,separator).trim().toLowerCase();
    const value=line.slice(separator+1).trim();
    // OS-specific wg-quick directives are never passed into Xray.
    section[key]=['address','dns','allowedips'].includes(key)&&section[key]?`${section[key]},${value}`:value;
  }
  if(!settings||!peers.length)throw profileError('WireGuard needs Interface and Peer sections');
  const parsedPeers=peers.map(wirePeer);
  const {host,port}=endpoint(parsedPeers[0].endpoint);
  if(!settings.reserved)settings.reserved=peers[0].reserved;
  return {name:`WireGuard · ${host}`,type:'WireGuard',host,port,outbound:wireOutbound(settings,parsedPeers)};
}

function hysteria(raw) {
  const portRange=raw.match(/^(hy2:\/\/|hysteria2:\/\/)([^/?#]+):(\d+(?:[,-]\d+)+)(?=[/?#]|$)/i);
  const url=parseUrl(portRange?portRange[1]+portRange[2]+':'+portRange[3].split(/[,-]/)[0]+raw.slice(portRange[0].length):raw);
  const port=portNumber(url.port||443);
  const options=readQuery(url);
  const auth=decode(url.username)+(url.password?':'+decode(url.password):'');
  const tlsSettings={serverName:options.sni||url.hostname};
  const pin=options.pinsha256?.replaceAll(':','');
  if(pin){
    if(!/^[\da-f]{64}$/i.test(pin))throw profileError('invalid Hysteria2 TLS certificate pin');
    tlsSettings.pinnedPeerCertSha256=pin;
  }else if(['1','true'].includes(options.insecure?.toLowerCase())){
    throw profileError('Hysteria2 with disabled certificate verification needs a SHA-256 certificate pin');
  }
  if(options.ech)tlsSettings.echConfigList=options.ech;
  if(options.alpn)tlsSettings.alpn=list(options.alpn);
  const streamSettings={network:'hysteria',security:'tls',tlsSettings,hysteriaSettings:{version:2,auth}};
  const finalmask={};
  const obfs=options.obfs?.toLowerCase();
  if(obfs&&obfs!=='none'){
    if(!['salamander','gecko'].includes(obfs)||!options['obfs-password']){
      throw profileError('unsupported or incomplete Hysteria2 obfuscation');
    }
    const mask={password:options['obfs-password']};
    if(obfs==='gecko')mask.packetSize='512-1200';
    finalmask.udp=[{type:'salamander',settings:mask}];
  }
  const ports=(options.mport||portRange?.[3])?.trim();
  if(ports){
    if(!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ports))throw profileError('invalid Hysteria2 port range');
    for(const segment of ports.split(',')){
      const [first,last]=segment.split('-').map(part=>portNumber(part));
      if(last<first)throw profileError('invalid Hysteria2 port range');
    }
    finalmask.quicParams={udpHop:{ports}};
  }
  if(Object.keys(finalmask).length)streamSettings.finalmask=finalmask;
  return profile('Hysteria2',url,port,{tag:'proxy',protocol:'hysteria',settings:{version:2,address:url.hostname,port},streamSettings});
}

function upstreamProxy(raw,protocol) {
  const url=parseUrl(raw);
  const inputScheme=url.protocol.slice(0,-1);
  const secure=inputScheme==='https-proxy'||inputScheme==='https'||url.searchParams.get('security')==='tls';
  const defaultPort=protocol==='socks'?1080:secure?443:80;
  const port=portNumber(url.port||defaultPort);
  const settings={address:url.hostname,port};
  if(url.username){
    settings.user=decode(url.username);
    settings.pass=decode(url.password);
  }
  const outbound={tag:'proxy',protocol,settings};
  if(secure){
    outbound.streamSettings={network:'raw',security:'tls',tlsSettings:{serverName:url.searchParams.get('sni')||url.hostname}};
  }
  return profile(protocol==='socks'?'SOCKS5':secure?'HTTPS':'HTTP',url,port,outbound);
}

// HTTP(S) subscription URLs keep their existing meaning. A URL with userinfo
// at the proxy endpoint is unambiguous. Use http(s)-proxy:// for other proxies.
export function isHttpProxyUrl(raw){
  return /^https?:\/\/[^/?#]+@[^/?#]+\/?(?:[?#].*)?$/i.test(raw);
}

export function parseExtraProfile(raw) {
  if(isWireGuardConfig(raw))return wireConf(raw);
  if(/^(?:wireguard|wg):\/\//i.test(raw))return wireLink(raw);
  if(/^(?:hysteria2|hy2):\/\//i.test(raw))return hysteria(raw);
  if(/^socks(?:5h?)?:\/\//i.test(raw))return upstreamProxy(raw,'socks');
  if(/^https?-proxy:\/\//i.test(raw)||isHttpProxyUrl(raw))return upstreamProxy(raw,'http');
  return null;
}
