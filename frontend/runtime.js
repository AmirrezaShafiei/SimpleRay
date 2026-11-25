/** Shared connection/ping view logic. Pure functions make UI behavior testable. */
export const DEFAULT_PING_SAMPLES=2;

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
  const {shouldStop, isCurrent, onStage, onPreliminary} = options;
  const preliminary = new Map();
  const initialSamples = samples - 1;
  let finished = 0;
  const report = (server, result) => {
    if (result.latencyStatus !== 'cancelled') finished++;
    onResult(server, result, finished, servers.length);
  };
  await pingPool(servers, initialSamples,
    server => isCurrent(server) ? runOne(server, initialSamples, false) : undefined,
    (server, result, done, total, raw) => {
      if (isCurrent(server)) {
        if (raw?.attempted > 0) {
          preliminary.set(server, {result, raw});
          onPreliminary(server, result);
        } else {
          report(server, result);
        }
      }
      onStage(done, total, false, false);
    }, options);

  const remaining = [...preliminary.keys()].filter(isCurrent);
  const extended = !remaining.some(server => Number.isFinite(preliminary.get(server).result.latency));
  if (remaining.length && !shouldStop()) {
    onStage(0, remaining.length, true, extended);
    await pingPool(remaining, 1,
      server => isCurrent(server) ? runOne(server, 1, extended) : undefined,
      (server, result, done, total, raw) => {
        if (isCurrent(server)) {
          report(server, combinedPing(preliminary.get(server), result, raw));
        }
        preliminary.delete(server);
        onStage(done, total, true, extended);
      }, options);
  }
  if (shouldStop()) {
    for (const server of preliminary.keys()) {
      if (isCurrent(server)) {
        report(server, {latency: null, latencyStatus: 'cancelled', latencySuccess: 0, latencyAttempted: 0});
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

export async function pingPool(servers,samples,runOne,onProgress,{concurrency=4,shouldStop=()=>false}={}){
  if(![1,2,3].includes(samples))throw new Error('Ping count must be 1, 2 or 3');
  const list=[...servers];let next=0,finished=0;
  const workers=Array.from({length:Math.min(concurrency,list.length)},async()=>{
    while(!shouldStop()){
      const index=next++;if(index>=list.length)break;
      const server=list[index];let result,raw;
      try{
        raw=await runOne(server,samples);
        result=normalizedLatencyResult(raw,samples);
      }
      catch(error){
        const cancelled = shouldStop() || (error?.message ?? error) === 'Test cancelled';
        result={latency:null,latencyStatus:cancelled?'cancelled':'start-failed',latencySuccess:0,latencyAttempted:0};
      }
      if (result.latencyStatus !== 'cancelled') finished++;
      onProgress?.(server,result,finished,list.length,raw);
    }
  });
  await Promise.all(workers);
  return {finished,total:list.length,cancelled:shouldStop()};
}
