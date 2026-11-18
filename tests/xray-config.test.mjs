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
