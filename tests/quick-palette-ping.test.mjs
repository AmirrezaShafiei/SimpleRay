import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PALETTES,readAppearance,applyAppearance} from '../frontend/appearance.js';
import {pingPool} from '../frontend/runtime.js';
const read=path=>readFileSync(path,'utf8');
const storage=p=>({getItem:()=>JSON.stringify(p)});
test('three palettes + independent system/light/dark + validated custom colors',()=>{
 assert.deepEqual(Object.keys(PALETTES),['ocean','forest','violet']);
 const pref=readAppearance(storage({palette:'custom',theme:'light',customPrimary:'#aBcDef',customAccent:'red;'}));
 assert.equal(pref.mode,'light');assert.equal(pref.palette,'custom');assert.equal(pref.primary,'#abcdef');assert.equal(pref.accent,'#23c3c7');
 const root={dataset:{},style:{values:{},setProperty(k,v){this.values[k]=v}}};
 applyAppearance(root,pref,false);assert.equal(root.dataset.theme,'light');assert.equal(root.style.values['--theme-primary'],'#abcdef');
 applyAppearance(root,{...pref,mode:'system'},true);assert.equal(root.dataset.theme,'light');
 applyAppearance(root,{...pref,mode:'system'},false);assert.equal(root.dataset.theme,'dark');
});
test('Ping All supports one, two or three actual samples',async()=>{
 for(const count of [1,2,3]){
  const result=await pingPool([{id:'a'}],count,async(_,samples)=>({attempted:samples,successful:samples,averageMs:145}),()=>{});
  assert.equal(result.finished,1);
 }
 const main=read('frontend/main.js'),engine=read('src-tauri/src/engine.rs'),html=read('frontend/index.html');
 assert.match(main,/pingSamples:pref\.pingPreferenceVersion===2[^\n]*\?1:2/);
 assert.match(engine,/\[1,2,3\]\.contains\(&samples\)/);
 for(const count of [1,2,3])assert.match(html,new RegExp('value="'+count+'"'));
 assert.match(main,/Ping \(×2\) — Average/);
});
test('suggestions pop up only when main hidden, are throttled, and quick switch supports real connection',()=>{
 const tray=read('src-tauri/src/tray.rs'),quick=read('frontend/quick.js');
 const tauri=JSON.parse(read('src-tauri/tauri.conf.json')),caps=JSON.parse(read('src-tauri/capabilities/default.json'));
 const w=tauri.app.windows.find(w=>w.label==='quick');
 assert.equal(w.visible,false);assert.equal(w.skipTaskbar,true);assert.equal(w.decorations,false);
 assert.ok(caps.windows.includes('quick'));
 assert.match(tray,/main_is_visible\(app\)/);
 assert.match(tray,/Duration::from_secs\(90\)/);
 assert.match(tray,/WindowEvent::Focused\(false\)/);
 assert.match(quick,/accept_server_suggestion/);
 assert.match(quick,/connect_server/);
 assert.match(quick,/quick_selection_changed/);
 assert.match(quick,/hide_quick_panel/);
});
