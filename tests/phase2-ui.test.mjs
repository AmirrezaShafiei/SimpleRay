import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const html=readFileSync('frontend/index.html','utf8');const main=readFileSync('frontend/main.js','utf8');const css=readFileSync('frontend/styles.css','utf8');
test('one main window, no sidebar, Source not Remarks',()=>{assert.match(html,/data-sort="source"/);assert.doesNotMatch(html,/<(aside|nav)\b/i);assert.doesNotMatch(html,/Remarks/)});
test('Paste/Update/Ping fixed ordering and modal manager',()=>{
 assert.ok(html.indexOf('id="pasteButton"')<html.indexOf('id="updateButton"'));
 assert.ok(html.indexOf('id="updateButton"')<html.indexOf('id="pingAllButton"'));
 for(const id of ['manualDialog','subscriptionDialog','manageDialog','subscriptionName','subscriptionUrl','subscriptionList'])assert.ok(html.includes(`id="${id}"`));
});
test('native runtime only, no fake live connection or latency',()=>{assert.match(main,/!nativeHost\(\)/);assert.match(main,/connect_server/);assert.match(main,/measure_server_latency/);assert.doesNotMatch(css,/\.latency-text\{[^}]*background:/)});
