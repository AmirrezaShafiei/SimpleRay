import test from 'node:test';
import assert from 'node:assert/strict';
import {parseImport,parseShareLink,parseSubscriptionPayload,validateSubscriptionUrl} from '../frontend/config.js';
const uuid='11111111-2222-4333-8444-555555555555';
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const vmess=(name='Berlin',host='de.test')=>'vmess://'+b64(JSON.stringify({v:'2',ps:name,add:host,port:'443',id:uuid,aid:'0',net:'ws',tls:'tls'}));
const vless=`vless://${uuid}@example.org:443?security=reality&type=grpc&sni=example.org#Fast%20node`;
const trojan='trojan://pa%40ssword@trojan.example:8443?security=tls#Trojan%20EU';
const ss='ss://'+b64('aes-256-gcm:p%40ssword@ss.example:8388')+'#SS%20server';

test('VMess legacy base64 JSON including UTF-8 label parses',()=>{
 const s=parseShareLink(vmess('日本語'));assert.equal(s.type,'VMess');assert.equal(s.host,'de.test');assert.equal(s.name,'日本語');assert.equal(s.latency,null);
});
test('VLESS Reality, Trojan URL and Shadowsocks common forms parse',()=>{
 assert.deepEqual([vless,trojan,ss].map(x=>parseShareLink(x).type),['VLESS','Trojan','Shadowsocks']);
 assert.equal(parseShareLink(vless).name,'Fast node');assert.equal(parseShareLink(trojan).port,8443);
 assert.equal(parseShareLink('ss://'+b64('aes-256-gcm:secret')+'@ss.example:443#node').host,'ss.example');
});
test('malformed configurations fail with sanitized errors',()=>{
 for(const uri of ['vless://notuuid@host:443#secret','vmess://notbase64','trojan://pass@host:99999','ss://broken']){
  assert.throws(()=>parseShareLink(uri),e=>!e.message.includes(uri));
 }
});
test('plain or base64 multi-line subscription payloads are recognized',()=>{
 const input=[vmess(),vless,trojan,ss].join('\n');
 assert.equal(parseSubscriptionPayload(input).servers.length,4);
 assert.equal(parseSubscriptionPayload(b64(input)).servers.length,4);
});
test('import identifies URLs separately and reports invalid lines without raw content',()=>{
 const p=parseImport([vless,'https://example.org/sub?id=token','fake://secretvalue'].join('\n'));
 assert.equal(p.servers.length,1);assert.equal(p.subscriptionUrls.length,1);assert.equal(p.errors.length,1);
 assert.ok(!JSON.stringify(p.errors).includes('secretvalue'));
});
test('rejects unsafe, local or unsupported subscription addresses',()=>{
 for(const u of ['file:///tmp/config','ftp://example.org/sub','https://user:pass@example.org','http://localhost/sub','https://example.org/sub#secret'])assert.throws(()=>validateSubscriptionUrl(u));
 assert.equal(validateSubscriptionUrl('https://example.org/sub?a=b'),'https://example.org/sub?a=b');
});
test('VMess stable signature excludes the display name',()=>{
 assert.equal(parseShareLink(vmess('Germany')).signature,parseShareLink(vmess('Renamed')).signature);
});
test('invalid base64 subscription does not remove existing data',()=>{
 assert.throws(()=>parseSubscriptionPayload('eW91IGFyZSBub3QgYSBjb25maWc='));
});
