import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read=file=>readFileSync(file,'utf8');
const rust=read('src-tauri/src/lib.rs');
const tray=read('src-tauri/src/tray.rs');
const pref=read('src-tauri/src/preferences.rs');
const engine=read('src-tauri/src/engine.rs');
const html=read('frontend/index.html');
const frontend=read('frontend/main.js');
const pipeline=read('.github/workflows/windows-beta.yml');

test('Phase 5: one persistent native shell and close-to-tray behavior',()=>{
  assert.match(tray,/WindowEvent::CloseRequested/);
  assert.match(tray,/api\.prevent_close\(\)/);
  assert.match(tray,/minimize_to_tray/);
  assert.match(tray,/window\.hide\(\)/);
  assert.match(tray,/request_exit\(app\.clone\(\)\)/);
  assert.match(rust,/on_window_event\(tray::handle_window_event\)/);
});
test('Phase 5: explicit tray Exit cleans System Proxy before terminating',()=>{
  assert.match(tray,/manager\.disconnect\(&app\)\.await/);
  assert.match(tray,/Ok\(_\)=>app\.exit\(0\)/);
  assert.match(tray,/Err\(error\)=>/);
  assert.match(tray,/ExitGuard/);
});
test('Phase 5: Start with Windows and Auto-connect are separate settings',()=>{
  assert.match(pref,/HKEY_CURRENT_USER/);
  assert.match(pref,/Software\\Microsoft\\Windows\\CurrentVersion\\Run/);
  assert.match(pref,/--minimized/);
  assert.match(pref,/auto_connect: false/);
  assert.match(pref,/minimize_to_tray: true/);
  assert.match(frontend,/set_autostart_enabled/);
  assert.match(frontend,/get_desktop_settings/);
  assert.match(frontend,/desktop\.autoConnect/);
  for (const id of ['startupToggle','trayToggle','autoConnectToggle']) assert.ok(html.includes(`id="${id}"`));
});
test('Phase 5: built-in tray menu includes show, connect/disconnect, and exit',()=>{
  assert.match(tray,/"Show SimpleRay"/);
  assert.match(tray,/"Connect \/ Disconnect"/);
  assert.match(tray,/"Exit SimpleRay"/);
  assert.match(frontend,/simpleray:tray-toggle/);
});
test('Phase 6: Xray stats API is routed through loopback dokodemo-door inbound',()=>{
  assert.match(engine, /"protocol":"dokodemo-door"/);
  assert.match(engine,/"inboundTag":\["api-in"\]/);
  assert.match(engine,/"outboundTag":"api"/);
  assert.match(engine,/"services":\["StatsService"\]/);
  assert.doesNotMatch(engine,/"api"\]=json!\(\{"tag":"api","listen"/);
});
test('Phase 6: bundled executable and geo assets plus license are required',()=>{
  const config=JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.bundle.targets[0],'nsis');
  assert.deepEqual(config.bundle.resources.slice(0,3),['binaries/xray.exe','binaries/geoip.dat','binaries/geosite.dat']);
  assert.ok(config.bundle.resources.includes('licenses/XRAY-LICENSE.txt'));
  assert.match(engine,/resource_dir\(\)/);
});
test('Phase 6: Windows CI tests both JS and Rust, pins official Xray digest, publishes only after successful build',()=>{
  assert.match(pipeline,/windows-2022/);
  assert.match(pipeline,/npm test/);
  assert.match(pipeline,/cargo test --locked --manifest-path/);
  assert.match(pipeline,/1262522266337b824f07beb8e1375786b437683b3890105469088f8e17e0a69d/);
  assert.match(pipeline,/Get-FileHash/);
  assert.match(pipeline,/npm run desktop:build/);
  assert.match(pipeline,/Verify installation and application startup/);
  assert.match(pipeline,/gh release create/);
  assert.match(pipeline,/--prerelease/);
});
test('Phase 6: source layout remains minimalist and has no fake live data when disconnected',()=>{
  assert.doesNotMatch(html,/<aside\b/);
  assert.match(html,/id="startupStatus"/);
  assert.match(html,/id="pingAllButton"/);
  assert.match(html,/data-sort="source"/);
  assert.match(frontend,/\$\('traffic'\)\.hidden=!connected/);
  assert.ok(existsSync('design/reference.jpg'));
});

test('server switching compares six alternatives even when the active server is in the source',()=>{
  const switching=read('src-tauri/src/switching.rs');
  assert.match(switching,/pub const MAX_CANDIDATES: usize = 6;/);
  assert.match(engine,/candidates\.len\(\)>switching::MAX_CANDIDATES\+1/);
  assert.match(engine,/filter\(\|candidate\| &candidate\.server_id!=active_id\)\s*\.take\(switching::MAX_CANDIDATES\)/);
  assert.match(frontend,/const MAX_SWITCH_CANDIDATES = 6;/);
  assert.match(frontend,/candidates\.length===MAX_SWITCH_CANDIDATES\+1/);
  assert.match(html,/Up to 6 candidates, in saved order/);
});
