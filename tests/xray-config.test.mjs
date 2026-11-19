import test from 'node:test';
import assert from 'node:assert/strict';
import {outboundFromShareLink,outboundSummary} from '../frontend/xray-config.js';
const id='11111111-2222-4333-8444-555555555555';
test('VLESS TLS + websocket maps to outbound stream and credentials',()=>{
  const s=outboundFromShareLink(`vless://${id}@example.com:443?type=ws&security=tls&sni=cdn.example.com&host=cdn.example.com&path=%2Ftunnel#GB`);
  assert.equal(s.tag,'proxy');assert.equal(s.protocol,'vless');
  assert.equal(s.settings.vnext[0].users[0].id,id);
  assert.equal(s.streamSettings.wsSettings.path,'/tunnel');
  assert.equal(s.streamSettings.tlsSettings.serverName,'cdn.example.com');
  assert.equal(s.streamSettings.wsSettings.headers.Host,'cdn.example.com');
  assert.deepEqual(outboundSummary(s),{protocol:'vless',transport:'ws',security:'tls'});
});
test('VLESS REALITY uses modern Xray password field, short ID, fingerprint',()=>{
  const s=outboundFromShareLink(`vless://${id}@1.2.3.4:443?type=tcp&security=reality&pbk=publicKeyValue&sid=aabb&sni=example.org&fp=chrome&flow=xtls-rprx-vision#One`);
  assert.equal(s.streamSettings.realitySettings.password,'publicKeyValue');
  assert.equal(s.streamSettings.realitySettings.shortId,'aabb');
  assert.equal(s.streamSettings.realitySettings.serverName,'example.org');
  assert.equal(s.settings.vnext[0].users[0].flow,'xtls-rprx-vision');
  assert.ok(!('publicKey' in s.streamSettings.realitySettings));
});
test('VLESS XHTTP recognizes mode, host and path',()=>{
  const s=outboundFromShareLink(`vless://${id}@example.com:443?security=tls&type=xhttp&mode=stream-up&path=%2Fupload&host=front.example.com`);
  assert.equal(s.streamSettings.xhttpSettings.mode,'stream-up');
  assert.equal(s.streamSettings.xhttpSettings.host,'front.example.com');
});
test('Trojan HTTPUpgrade with TLS',()=>{
  const s=outboundFromShareLink('trojan://pass%40word@node.example.com:443?type=httpupgrade&security=tls&path=%2Fx#T');
  assert.equal(s.settings.servers[0].password,'pass@word');
  assert.equal(s.streamSettings.httpupgradeSettings.path,'/x');
});
test('VMess JSON base64 decodes to Xray structure',()=>{
  const config={v:'2',ps:'Server',add:'myserver.example.com',port:'443',id,aid:'0',scy:'auto',net:'ws',host:'ws.example.com',path:'/ws',tls:'tls',sni:'myserver.example.com'};
  const uri='vmess://'+Buffer.from(JSON.stringify(config),'utf8').toString('base64');
  const s=outboundFromShareLink(uri);
  assert.equal(s.protocol,'vmess');assert.equal(s.settings.vnext[0].users[0].alterId,0);
  assert.equal(s.streamSettings.wsSettings.path,'/ws');
});
test('Shadowsocks URI decodes method/password without plugin',()=>{
  const credentials=Buffer.from('aes-128-gcm:secret').toString('base64url');
  const s=outboundFromShareLink(`ss://${credentials}@ss.example.com:8388#SS`);
  assert.equal(s.protocol,'shadowsocks');assert.equal(s.settings.servers[0].method,'aes-128-gcm');
  assert.equal(s.settings.servers[0].password,'secret');
});
test('unknown transport, plugin and invalid REALITY shortID are rejected without echoing private URI',()=>{
  for(const uri of [
    `vless://${id}@example.com:443?type=quic&security=tls#abc`,
    `vless://${id}@example.com:443?type=ws&security=reality&pbk=secret&sni=google.com#abc`,
    `vless://${id}@example.com:443?type=tcp&security=reality&pbk=secret&sni=google.com&sid=abc#abc`,
    'ss://YWVzLTEyOC1nY206cGFzcw@example.com:8388?plugin=obfs-local%3Bobfs%3Dhttp'
  ])assert.throws(()=>outboundFromShareLink(uri),e=>!e.message.includes('secret')&&!e.message.includes('pass')&&!e.message.includes('google.com'));
});

const wgSecret=Buffer.alloc(32,7).toString('base64');
const wgPublic=Buffer.alloc(32,8).toString('base64');
const wgShare=`wireguard://${encodeURIComponent(wgSecret)}@[2001:db8::1]:51820?publickey=${encodeURIComponent(wgPublic)}&address=10.7.0.2%2F32&reserved=1,2,3#WG`;
test('WireGuard share links and wg-quick text produce a user-space WireGuard outbound',()=>{
  const link=outboundFromShareLink(wgShare);
  assert.deepEqual(link.settings.peers,[{endpoint:'[2001:db8::1]:51820',publicKey:wgPublic}]);
  assert.deepEqual(link.settings.reserved,[1,2,3]);
  const text=outboundFromShareLink(`# exported profile\n[Interface]\nPrivateKey = ${wgSecret}\nAddress = 10.7.0.2/32\nDNS = 1.1.1.1\nPostUp = example-hook\n[Peer]\nPublicKey = ${wgPublic}\nEndpoint = [2001:db8::1]:51820\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25`);
  assert.equal(text.settings.secretKey,wgSecret);
  assert.equal(text.settings.noKernelTun,true);
  assert.equal(text.settings.peers[0].keepAlive,25);
  assert.deepEqual(text.settings.peers[0].allowedIPs,['0.0.0.0/0','::/0']);
  assert.ok(!JSON.stringify(text).includes('example-hook'));
  assert.throws(()=>outboundFromShareLink(wgShare.replace(encodeURIComponent(wgPublic),'bad-public-key')),/32-byte WireGuard key/);
});

test('alternate VMess URLs, Hysteria2, SOCKS5 and HTTPS proxy map to distinct outbounds',()=>{
  const vm=outboundFromShareLink(`vmess://${id}@example.test:443?type=ws&path=%2Fws&security=tls`);
  assert.equal(vm.settings.vnext[0].users[0].id,id);
  assert.equal(vm.streamSettings.wsSettings.path,'/ws');
  const hy=outboundFromShareLink('hy2://user:pass@example.test:443,5000-5003/?sni=proxy.test&obfs=salamander&obfs-password=mask');
  assert.equal(hy.protocol,'hysteria');
  assert.equal(hy.streamSettings.hysteriaSettings.auth,'user:pass');
  assert.equal(hy.streamSettings.finalmask.quicParams.udpHop.ports,'443,5000-5003');
  assert.equal(hy.streamSettings.finalmask.udp[0].settings.password,'mask');
  assert.equal(outboundFromShareLink('hysteria2://pass@example.test').settings.port,443);
  assert.throws(()=>outboundFromShareLink('hy2://pass@example.test?insecure=1'),/certificate pin/);
  const socks=outboundFromShareLink('socks5://user:p%40ss@example.test:1080');
  assert.equal(socks.settings.pass,'p@ss');
  assert.equal(socks.protocol,'socks');
  const https=outboundFromShareLink('https-proxy://example.test:8443');
  assert.equal(https.protocol,'http');
  assert.equal(https.streamSettings.security,'tls');
});
