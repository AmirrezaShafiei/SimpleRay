import test from 'node:test';
import assert from 'node:assert/strict';
import {DEMO_SERVERS,filterServers,sortServers,latencyClass,stabilityLevel} from '../frontend/model.js';
test('fixtures have expected fields and standalone source em dash',()=>{assert.equal(DEMO_SERVERS.length,7);assert.ok(DEMO_SERVERS.some(s=>s.source==='—'));assert.ok(DEMO_SERVERS.every(s=>s.id&&s.name&&s.type&&s.source))});
test('sorting works ascending and descending for all five headers',()=>{for(const key of ['favorite','name','type','latency','source']){const a=sortServers(DEMO_SERVERS,key,'asc'),b=sortServers(DEMO_SERVERS,key,'desc');assert.equal(a.length,7);assert.equal(b.length,7);assert.notDeepEqual(a.map(s=>s.id),b.map(s=>s.id),key)}});
test('latency numeric sort and missing always last',()=>{const rows=[{name:'slow',latency:300},{name:'unmeasured',latency:null},{name:'fast',latency:30},{name:'timeout',latency:NaN},{name:'middle',latency:110}];assert.deepEqual(sortServers(rows,'latency','asc').map(s=>s.name),['fast','middle','slow','unmeasured','timeout']);assert.deepEqual(sortServers(rows,'latency','desc').map(s=>s.name),['slow','middle','fast','unmeasured','timeout'])});
test('download speed sorts numerically across the measured servers',()=>{
  const rows = [{id:'slow',downloadMbps:2,pinned:true},{id:'missing',pinned:true},{id:'fast',downloadMbps:10}];
  assert.deepEqual(sortServers(rows,'downloadMbps','desc').map(row=>row.id),['fast','slow','missing']);
  assert.deepEqual(sortServers(rows,'downloadMbps','asc').map(row=>row.id),['slow','fast','missing']);
});
test('natural alphanumeric server name sorting',()=>{const r=[{name:'Server 10'},{name:'Server 2'}];assert.deepEqual(sortServers(r,'name').map(s=>s.name),['Server 2','Server 10'])});
test('search checks name, protocol and source case-insensitively',()=>{assert.equal(filterServers(DEMO_SERVERS,'GERMany').length,1);assert.equal(filterServers(DEMO_SERVERS,'vmess').length,3);assert.equal(filterServers(DEMO_SERVERS,'backup').length,1);assert.equal(filterServers(DEMO_SERVERS,'does-not-exist').length,0)});
test('latency colors include the exact 200, 400 and 800 ms boundaries',()=>{
  assert.deepEqual([0,200,201,300,400,401,800,801,null].map(latencyClass),[
    'latency-good','latency-good','latency-ok','latency-ok','latency-ok','latency-slow','latency-slow','latency-bad','latency-unknown'
  ]);
});
test('pinned servers stay first in both directions and without a selected sort',()=>{
  const rows=DEMO_SERVERS.map(row=>({...row,pinned:['demo-us','demo-tr'].includes(row.id)}));
  for(const key of ['favorite','name','type','latency','source',null]){
    for(const direction of ['asc','desc']){
      const sorted=sortServers(rows,key,direction);
      assert.ok(sorted.slice(0,2).every(row=>row.pinned),`${key} ${direction}`);
      assert.ok(sorted.slice(2).every(row=>!row.pinned));
    }
  }
  assert.deepEqual(sortServers(rows,'latency','asc').slice(0,2).map(row=>row.id),['demo-tr','demo-us']);
  assert.deepEqual(sortServers(rows,'latency','desc').slice(0,2).map(row=>row.id),['demo-us','demo-tr']);
});
test('stability has independent thresholds',()=>{
  assert.deepEqual([10,9,8,7,6,4,3,0].map(n=>stabilityLevel(n,10)),[
    'stable','stable','fair','fair','unstable','unstable','poor','poor'
  ]);
  assert.equal(stabilityLevel(0,0),'unknown');
});
