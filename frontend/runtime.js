/** Shared connection/ping view logic. Pure functions make UI behavior testable. */
export const DEFAULT_PING_SAMPLES=2;
const MAX_PARALLEL_PINGS=4;

export function formatBytes(value){
  if(!Number.isFinite(value)||value<0)return '—';
  if(value<1024)return `${Math.round(value)} B`;
  const units=['KB','MB','GB','TB'];let x=value/1024,i=0;
  while(x>=1024&&i<units.length-1){x/=1024;i++}
  return `${x.toFixed(x>=100?0:x>=10?1:2)} ${units[i]}`;
}
export function bytesPerSecond(value){
  const amount=formatBytes(value);
  return amount==='—'?amount:`${amount}/s`;
}
export function formatDownloadSpeed(value){
  if(!Number.isFinite(value)||value<=0)return '—';
  const megabytes=value>=1_000_000;
  const amount=value/(megabytes?1_000_000:1_000);
  return `${Number(amount.toFixed(amount>=10?1:2))} ${megabytes?'MB':'KB'}/s`;
}
export function normalizedLatencyResult(result,samples){
  const attempted=Number(result?.attempted)||samples;
  const successful=Number(result?.successful)||0;
  const average=result?.averageMs;
  if(!successful||!Number.isFinite(average)||average<0){
    const timedOut=!result?.reason||/timed out/i.test(result.reason);
    return {latency:null,latencyStatus:timedOut?'timeout':'probe-failed',latencySuccess:0,latencyAttempted:attempted};
  }
  return {latency:Math.round(average),latencyStatus:successful<attempted?'partial':'ok',latencySuccess:successful,latencyAttempted:attempted};
}
export function latencyResponseCount(result) {
  const {latencyAttempted: attempted, latencySuccess: successful, latencyStatus, provisional} = result;
  // Before beta.12, an "error" record could count probes that never started.
  if (provisional || latencyStatus === 'error' || ![2, 3].includes(attempted) ||
      !Number.isInteger(successful) || successful < 0 || successful > attempted) return '';
  return `${successful}/${attempted}`;
}

export async function pingWithFallback(servers, samples, runOne, onResult, options) {
  if (![2, 3].includes(samples)) throw new Error('Ping count must be 2 or 3');
  const {concurrency=MAX_PARALLEL_PINGS, shouldStop, isCurrent, onStage, onPreliminary} = options;
  const preliminary = new Map();
  const fastReplies = new Set();
  const running = new Set();
  const initialSamples = samples - 1;
  let next = 0;
  let initialDone = 0;
  let finished = 0;
  let extendedAnnounced = false;
  let latestReady;
  let wake = () => {};
  const report = (server, result) => {
    if (result.latencyStatus !== 'cancelled') finished++;
    onResult(server, result, finished, servers.length);
  };

  function recordFastReply(server, result) {
    if (Number.isFinite(result.latency) && !fastReplies.has(server)) {
      fastReplies.add(server);
      wake();
    }
  }
  async function runInitial(server) {
    if (isCurrent(server)) {
      const {result, raw} = await runPing(() => runOne(server, initialSamples, false, first => {
        if (!isCurrent(server) || shouldStop()) return;
        recordFastReply(server, first);
        onPreliminary(server, first);
      }), initialSamples, shouldStop);
      if (isCurrent(server) && raw?.attempted > 0) {
        preliminary.set(server, {result, raw});
        latestReady = server;
        recordFastReply(server, result);
        onPreliminary(server, result);
      } else if (isCurrent(server)) {
        report(server, result);
      }
    }
    onStage(++initialDone, servers.length, false, false);
  }

  async function runFinal(server, first, extended) {
    const {result, raw} = await runPing(() => runOne(server, 1, extended), 1, shouldStop);
    if (isCurrent(server)) report(server, combinedPing(first, result, raw));
  }

  const track = work => {
    const task = work.finally(() => running.delete(task));
    running.add(task);
  };
  while (!shouldStop()) {
    while (!shouldStop() && running.size < concurrency) {
      // Start final probes as soon as their timeout can be decided.
      const canUseShortTimeout = [...fastReplies].some(isCurrent);
      if (canUseShortTimeout || initialDone === servers.length) {
        const ready = canUseShortTimeout && preliminary.has(latestReady) && isCurrent(latestReady)
          ? latestReady : [...preliminary.keys()].find(isCurrent);
        if (ready) {
          const extended = !canUseShortTimeout;
          if (extended && !extendedAnnounced) {
            extendedAnnounced = true;
            onStage(0, preliminary.size, true, true);
          }
          if (shouldStop()) break;
          const first = preliminary.get(ready);
          preliminary.delete(ready);
          track(runFinal(ready, first, extended));
          continue;
        }
      }
      if (next === servers.length) break;
      track(runInitial(servers[next++]));
    }
    if (!running.size) break;
    await Promise.race([...running, new Promise(resolve => {wake = resolve})]);
  }
  await Promise.all(running);
  if (shouldStop()) {
    for (const server of preliminary.keys()) {
      if (isCurrent(server)) {
        report(server, incompletePing(true));
      }
    }
  }
  return {finished, total: servers.length, cancelled: shouldStop()};
}

function combinedPing({result: first, raw}, last, lastRaw) {
  if (last.latencyStatus === 'cancelled') return last;
  if (last.latencyStatus === 'start-failed') return first;
  const times = [...raw.samplesMs, ...lastRaw.samplesMs];
  return normalizedLatencyResult({
    averageMs: times.length ? times.reduce((sum, time) => sum + time, 0) / times.length : null,
    successful: times.length,
    attempted: raw.attempted + lastRaw.attempted,
    reason: [raw.reason, lastRaw.reason].find(reason => reason && !/timed out/i.test(reason)),
  });
}

function incompletePing(cancelled) {
  return {latency:null,latencyStatus:cancelled?'cancelled':'start-failed',latencySuccess:0,latencyAttempted:0};
}

async function runPing(run, samples, shouldStop) {
  try {
    const raw = await run();
    return {result: normalizedLatencyResult(raw, samples), raw};
  } catch (error) {
    const cancelled = shouldStop() || (error?.message ?? error) === 'Test cancelled';
    return {result: incompletePing(cancelled)};
  }
}

export async function pingPool(servers,samples,runOne,onProgress,{concurrency=MAX_PARALLEL_PINGS,shouldStop=()=>false}={}){
  if(![1,2,3].includes(samples))throw new Error('Ping count must be 1, 2 or 3');
  const list=[...servers];let next=0,finished=0;
  const workers=Array.from({length:Math.min(concurrency,list.length)},async()=>{
    while(!shouldStop()){
      const index=next++;if(index>=list.length)break;
      const server=list[index];
      const {result,raw}=await runPing(()=>runOne(server,samples),samples,shouldStop);
      if (result.latencyStatus !== 'cancelled') finished++;
      onProgress?.(server,result,finished,list.length,raw);
    }
  });
  await Promise.all(workers);
  return {finished,total:list.length,cancelled:shouldStop()};
}
