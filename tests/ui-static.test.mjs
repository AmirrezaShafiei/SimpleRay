import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync('frontend/index.html','utf8');
const css=readFileSync('frontend/styles.css','utf8');
const js=readFileSync('frontend/main.js','utf8');
test('single-window screenshot-inspired layout contains no sidebar or remarks',()=>{
  assert.match(html,/id="connectionSwitch"/);
  assert.doesNotMatch(html,/<(aside|nav)\b/i);
  assert.match(html,/data-sort="source"/);
  assert.doesNotMatch(html,/Remarks/);
  assert.match(html,/class="latency-current"/);
});
test('Ping button appears directly after Update',()=>{
  assert.ok(html.indexOf('id="updateButton"') < html.indexOf('id="pingAllButton"'));
});
test('selected-server actions appear in the context menu without a separate toolbar',()=>{
  assert.doesNotMatch(html,/bulkServerActions|pingSelectedButton|deleteSelectedButton/);
  assert.match(js,/function showContextMenu[\s\S]*?pingServers\(targets,samples\)[\s\S]*?removeServers\(targets\)/);
});
test('all five sortable headers exist',()=>{
  for(const col of ['favorite','name','type','latency','source'])assert.match(html,new RegExp('data-sort="'+col+'"'));
});
test('theme, settings, native capability messages and latency-text only',()=>{
  for(const v of ['value="dark"','value="light"','value="system"','id="settingsButton"','id="runtimeNotice"','id="contextMenu"'])assert.ok(html.includes(v),v);
  assert.match(js,/measure_server_latency/);
  assert.match(css,/\.latency-good\{color:var\(--green\)\}/);
  assert.doesNotMatch(css,/\.latency-text\{[^}]*background:/);
});
test('the compact desktop window uses one themed titlebar with working controls',()=>{
  const [window]=JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')).app.windows;
  assert.equal(window.decorations,false);
  assert.ok(window.width<1100&&window.height<700);
  assert.match(html,/<header class="app-titlebar" data-tauri-drag-region>/);
  assert.match(css,/\.app-titlebar\{[^}]*background:var\(--chrome\)/);
  for(const id of ['windowMinimize','windowMaximize','windowClose']){
    assert.ok(html.includes(`id="${id}"`));
    assert.ok(js.includes(`'${id}'`));
  }
  assert.match(js,/plugin:app\|version/);
});
test('the connection panel separates live latency and actual System Proxy status',()=>{
  const engine=readFileSync('src-tauri/src/engine.rs','utf8');
  assert.match(html,/id="activePingButton"[^>]*hidden/);
  assert.match(js,/nativeInvoke\('ping_active_connection',\{serverId:request.serverId\}\)/);
  assert.match(engine,/fn ping_active[\s\S]*?let mut result=probe_round\(port\).await/);
  assert.match(html,/id="systemProxyStatus">Auto with connection/);
  assert.match(js,/nativeInvoke\('restore_system_proxy'\)/);
});
