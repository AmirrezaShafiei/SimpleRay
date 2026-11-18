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
  assert.doesNotMatch(html,/id="pingSelectedButton"/);
});
test('all five sortable headers exist',()=>{
  for(const col of ['favorite','name','type','latency','source'])assert.match(html,new RegExp('data-sort="'+col+'"'));
});
test('theme, settings, preview warnings and non-executable controls present',()=>{
  for(const v of ['value="dark"','value="light"','value="system"','id="settingsButton"','Connection and real Ping are not active yet','id="contextMenu"'])assert.ok(html.includes(v),v);
  assert.match(js,/Phase 4/);
  assert.match(css,/\.latency-good\{color:var\(--green\)\}/);
  assert.doesNotMatch(css,/\.latency-text\{[^}]*background:/);
});
