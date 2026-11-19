import test from 'node:test';
import assert from 'node:assert/strict';
import {bytesPerSecond,formatBytes,normalizedLatencyResult,pingPool} from '../frontend/runtime.js';
test('measured traffic display units, zero and unavailable',()=>{
  assert.equal(bytesPerSecond(0),'0 B/s');
  assert.equal(bytesPerSecond(2048),'2.00 KB/s');
  assert.equal(bytesPerSecond(1024**2),'1.00 MB/s');
  assert.equal(bytesPerSecond(NaN),'—');
  assert.equal(formatBytes(1024**3 * 2),'2.00 GB');
  assert.equal(formatBytes(0),'0 B');
});
test('three real delay sample average and partial success metadata',()=>{
  assert.deepEqual(normalizedLatencyResult({averageMs:110,successful:2,attempted:3},3),{
    latency:110,latencyStatus:'partial',latencySuccess:2,latencyAttempted:3
  });
  assert.deepEqual(normalizedLatencyResult({averageMs:null,successful:0,attempted:3},3),{
    latency:null,latencyStatus:'timeout',latencySuccess:0,latencyAttempted:3
  });
});
test('Ping all caps parallelism at three and saves completion per node',async()=>{
  const servers=Array.from({length:8},(_,i)=>({id:`s${i}`}));let concurrent=0,maxConcurrent=0;const seen=[];
  const summary=await pingPool(servers,3,async()=>{
    concurrent++;maxConcurrent=Math.max(concurrent,maxConcurrent);
    await new Promise(resolve=>setTimeout(resolve,8));concurrent--;
    return {averageMs:87,successful:3,attempted:3};
  },(server,result,done,total)=>seen.push({id:server.id,result,done,total}),{concurrency:3});
  assert.equal(summary.finished,8);assert.equal(seen.length,8);assert.equal(maxConcurrent,3);
  assert.deepEqual(seen.at(-1).result,{latency:87,latencyStatus:'ok',latencySuccess:3,latencyAttempted:3});
});
test('failed proxy probes and missing averages never appear as a measured zero',()=>{
  assert.deepEqual(normalizedLatencyResult({averageMs:null,successful:0,attempted:1,reason:'Proxy request failed'},1),{
    latency:null,latencyStatus:'error',latencySuccess:0,latencyAttempted:1
  });
  assert.equal(normalizedLatencyResult({averageMs:null,successful:1,attempted:1},1).latency,null);
});
test('Ping All supports a single sample and cancels queued nodes',async()=>{
  const seen=[];let cancelled=false;
  const summary=await pingPool([{id:'a'},{id:'b'},{id:'c'}],1,async()=>({averageMs:80,successful:1,attempted:1}),server=>{
    seen.push(server.id);cancelled=true;
  },{concurrency:1,shouldStop:()=>cancelled});
  assert.deepEqual(seen,['a']);assert.equal(summary.finished,1);assert.equal(summary.cancelled,true);
});
test('Ping All supports two probes and reports the returned average',async()=>{
  const [row]=[{id:'a'}];
  let result;
  const summary=await pingPool([row],2,async()=>({averageMs:240,successful:2,attempted:2}),
    (_server,value)=>{result=value});
  assert.equal(summary.finished,1);
  assert.deepEqual(result,{latency:240,latencyStatus:'ok',latencySuccess:2,latencyAttempted:2});
});
