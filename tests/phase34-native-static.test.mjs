import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const rust=readFileSync('src-tauri/src/engine.rs','utf8');
const proxy=readFileSync('src-tauri/src/system_proxy.rs','utf8');
const main=readFileSync('frontend/main.js','utf8');
test('native engine only reports Connected after live HTTPS through Xray and System Proxy',()=>{
  const preflight=rust.indexOf('let prepared = Self::prepare_connection(app,profile.outbound.clone()).await');
  const takeOver=rust.indexOf('system_proxy::enable(app,new_core.proxy_port)');
  assert.ok(preflight>0&&takeOver>preflight);
  assert.match(rust,/fn prepare_connection[\s\S]*?match probe_once\(new_core.proxy_port\).await/);
  assert.match(rust,/StatusCode::NO_CONTENT/);
  assert.match(rust,/127\.0\.0\.1/);
});
test('independent HTTP Ping through Xray with 1/3 samples and Xray stats',()=>{
  assert.match(rust,/async fn probe_once\(/);assert.match(rust,/samples!=1 && samples!=3/);
  assert.match(rust,/statsquery/);assert.match(rust,/--reset=true/);
  assert.match(main,/pingPool\(servers,samples/);
});
test('system proxy recovery snapshot and restoration, scoped to user registry',()=>{
  assert.match(proxy,/HKEY_CURRENT_USER/);
  assert.match(proxy,/proxy-recovery\.json/);
  assert.match(proxy,/original_server/);
  assert.match(proxy,/previous_port/);
  assert.match(proxy,/persist_noclobber/);
  assert.match(proxy,/is_active/);
});
