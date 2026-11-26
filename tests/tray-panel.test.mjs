import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {outageLabel,trayConnectionAction,trayServers} from '../frontend/tray-panel-model.js';

const profile=(id, flags={})=>({id,name:`Server ${id}`,type:'VLESS',source:'Manual',...flags});
const servers=[profile('A',{pinned:true}),profile('B'),profile('C',{pinned:true}),profile('D',{favorite:true,subscriptionId:'west'}),profile('E')];
const ids=items=>items.map(item=>item.id);

test('the tray boosts a recommendation ahead of pins without removing any scrollable results',()=>{
  assert.deepEqual(ids(trayServers(servers,{suggestion:{serverId:'D'}})),['D','A','C','B','E']);
  assert.deepEqual(ids(servers),['A','B','C','D','E']);
});

test('the tray search and group selectors combine predictably',()=>{
  assert.deepEqual(ids(trayServers(servers,{group:'pinned',query:'server c',suggestion:{serverId:'B'}})),['C']);
  assert.deepEqual(ids(trayServers(servers,{group:'subscription:west'})),['D']);
  assert.deepEqual(ids(trayServers(servers,{group:'favorites'})),['D']);
});

test('the combined status card connects, disconnects or retries the correct server',()=>{
  assert.deepEqual(trayConnectionAction({serverId:'A'}),{action:'connect',serverId:'A',label:'Connect',primary:true});
  assert.equal(trayConnectionAction({connected:true,activeId:'B'}).action,'disconnect');
  assert.deepEqual(trayConnectionAction({connected:true,activeId:'B',retry:true}),{action:'retry',serverId:'B',label:'Retry',primary:true});
  assert.equal(outageLabel(3610),'1h 0m');
  assert.deepEqual(trayConnectionAction({connected:true,activeId:'B',proxyInactive:true}),
    {action:'restoreProxy',serverId:null,label:'Restore proxy',primary:true});
});

test('the tray offers Cancel while a manual switch is pending',()=>{
  assert.deepEqual(trayConnectionAction({activeId:'A',pendingId:'B',connected:true,busy:'Switching…'}),
    {action:'cancel',serverId:null,label:'Cancel',primary:false});
});

test('the tray has four visible rows, scrolls for more, and animates overflowing names on demand',()=>{
  const css=readFileSync('frontend/tray-panel.css','utf8');
  const html=readFileSync('frontend/tray-panel.html','utf8');
  const js=readFileSync('frontend/tray-panel.js','utf8');
  assert.match(css,/height: calc\(var\(--tray-row-height\) \* 4\)/);
  assert.match(css,/overflow-y: auto/);
  assert.match(css,/animation: tray-name-pan .* infinite/);
  assert.match(js,/scrollWidth-wrapper\.clientWidth/);
  assert.match(js,/pointerenter/);
  assert.match(js,/pointerleave/);
  const footer=html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/)[1];
  assert.deepEqual([...footer.matchAll(/<button id="([^"]+)"/g)].map(match=>match[1]),['trayOpen','trayExit']);
  assert.match(css,/grid-template-rows: auto auto auto auto auto/);
  assert.match(js,/keyboardServerId\?\?results\[0\]\.id/);
  assert.match(js,/event\.isComposing/);
});
