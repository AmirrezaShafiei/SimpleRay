import test from 'node:test';
import assert from 'node:assert/strict';
import {bytesPerSecond,formatBytes,latencyResponseCount,normalizedLatencyResult,pingPool,pingWithFallback,speedCandidates} from '../frontend/runtime.js';
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
    latency:null,latencyStatus:'probe-failed',latencySuccess:0,latencyAttempted:1
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

test('table response counts appear only for completed multi-probe results', () => {
  assert.equal(latencyResponseCount({latencySuccess: 2, latencyAttempted: 3}), '2/3');
  assert.equal(latencyResponseCount({latencySuccess: 0, latencyAttempted: 2}), '0/2');
  assert.equal(latencyResponseCount({latencySuccess: 0, latencyAttempted: 3, latencyStatus: 'probe-failed'}), '0/3');
  for (const result of [{}, {latencySuccess: 1, latencyAttempted: 1},
    {latencySuccess: 0, latencyAttempted: 3, latencyStatus: 'error'},
    {latencySuccess: 1, latencyAttempted: 2, provisional: true}]) {
    assert.equal(latencyResponseCount(result), '');
  }
});

test('failed startups and cancelled requests do not create failed probe counts', async () => {
  const results = [];
  const servers = [{id: 'failed'}, {id: 'cancelled'}];
  const summary = await pingPool(servers, 3, async server => {
    throw new Error(server.id === 'cancelled' ? 'Test cancelled' : 'Xray could not start');
  }, (_server, result) => results.push(result), {concurrency: 1});
  assert.equal(summary.finished, 1);
  assert.deepEqual(results.map(result => result.latencyStatus), ['start-failed', 'cancelled']);
  assert.ok(results.every(result => result.latencyAttempted === 0 && !latencyResponseCount(result)));
});

test('only the ten lowest fresh pings qualify for the download test', () => {
  const servers = Array.from({length: 13}, (_, index) => ({id: String(index), latency: 1}));
  const pings = new Map(servers.slice(1).reverse().map(server => [server.id, Number(server.id) * 10]));
  pings.set('2', 10);
  const result = speedCandidates(servers, pings);
  assert.equal(result.count, 12);
  assert.deepEqual(result.candidates.map(server => server.id), servers.slice(1, 11).map(server => server.id));
});

const probeResult = (attempted, ...times) => ({
  attempted, samplesMs: times, successful: times.length,
  averageMs: times.length ? Math.round(times.reduce((sum, time) => sum + time, 0) / times.length) : null,
  reason: times.length ? null : 'Proxy request timed out',
});
const fallbackOptions = {
  concurrency: 1, shouldStop: () => false, isCurrent: () => true,
  onStage() {}, onPreliminary() {},
};

test('one fast reply anywhere in the list keeps all final probes short', async () => {
  const servers = [{id: 'slow'}, {id: 'fast'}];
  const calls = [];
  const results = new Map();
  await pingWithFallback(servers, 3, (server, count, extended) => {
    calls.push([server.id, count, extended]);
    if (server.id === 'slow') return probeResult(count);
    return count === 2 ? probeResult(2, 201, 202) : probeResult(1, 205);
  }, (server, result) => results.set(server.id, result), fallbackOptions);
  assert.deepEqual(calls, [
    ['slow', 2, false], ['fast', 2, false], ['slow', 1, false], ['fast', 1, false],
  ]);
  assert.equal(results.get('fast').latency, 203);
  assert.equal(latencyResponseCount(results.get('fast')), '3/3');
  assert.equal(latencyResponseCount(results.get('slow')), '0/3');
});

for (const samples of [2, 3]) {
  test(`only the final probe can wait longer when all ${samples - 1} fast rounds miss`, async () => {
    const calls = [];
    const results = new Map();
    const report = await pingWithFallback([{id: 'slow'}, {id: 'invalid'}], samples, (server, count, extended) => {
      calls.push([server.id, count, extended]);
      if (server.id === 'invalid') throw Error('Xray could not start');
      return extended ? probeResult(1, 8000) : probeResult(count);
    }, (server, result) => results.set(server.id, result), fallbackOptions);
    assert.deepEqual(calls, [
      ['slow', samples - 1, false], ['invalid', samples - 1, false], ['slow', 1, true],
    ]);
    assert.equal(report.finished, 2);
    assert.equal(results.get('slow').latency, 8000);
    assert.equal(latencyResponseCount(results.get('slow')), `1/${samples}`);
    assert.equal(latencyResponseCount(results.get('invalid')), '');
  });
}

test('cancelling between phases or during the final phase stops queued probes', async () => {
  for (const duringFinal of [false, true]) {
    let stop = false;
    const servers = [{id: 'a'}, {id: 'b'}, {id: 'c'}];
    const finalCalls = [];
    const results = new Map();
    const summary = await pingWithFallback(servers, 2, (server, count, extended) => {
      if (!extended) return probeResult(count);
      finalCalls.push(server.id);
      if (server.id === 'a') return probeResult(1, 8000);
      stop = true;
      throw Error('Test cancelled');
    }, (server, result) => results.set(server.id, result), {
      ...fallbackOptions,
      shouldStop: () => stop,
      onStage(done, total, final) {
        if (!duringFinal && done === total && !final) stop = true;
      },
    });
    assert.deepEqual(finalCalls, duringFinal ? ['a', 'b'] : []);
    assert.equal(summary.cancelled, true);
    assert.equal(summary.finished, duringFinal ? 1 : 0);
    assert.equal(results.get('a').latencyStatus, duringFinal ? 'partial' : 'cancelled');
    assert.equal(results.get('b').latencyStatus, 'cancelled');
    assert.equal(results.get('c').latencyStatus, 'cancelled');
  }
});

test('removed servers do not decide the final timeout or receive a final probe', async () => {
  const servers = [{id: 'removed'}, {id: 'current'}];
  const current = new Set(servers);
  const finalCalls = [];
  await pingWithFallback(servers, 2, (server, count, extended) => {
    if (extended) finalCalls.push(server.id);
    return server.id === 'removed' ? probeResult(count, 100) : probeResult(count);
  }, () => {}, {
    ...fallbackOptions,
    isCurrent: server => current.has(server),
    onStage(done, total, final) {
      if (!final && done === total) current.delete(servers[0]);
    },
  });
  assert.deepEqual(finalCalls, ['current']);
});

test('a failed final startup retains only real attempts', async () => {
  let first = true;
  let result;
  await pingWithFallback([{id: 'a'}], 3, () => {
    if (!first) throw Error('Xray could not restart');
    first = false;
    return probeResult(2, 500);
  }, (_server, value) => { result = value; }, fallbackOptions);
  assert.equal(result.latency, 500);
  assert.equal(latencyResponseCount(result), '1/2');
});
