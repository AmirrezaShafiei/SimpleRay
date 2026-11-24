/** Shared connection/ping view logic. Pure functions make UI behavior testable. */
export const DEFAULT_PING_SAMPLES=2;
export const MAX_SPEED_SERVERS = 10;
export const SPEED_SAMPLE_MB = 3;

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
export function normalizedLatencyResult(result,samples){
  const attempted=Number(result?.attempted)||samples;
  const successful=Number(result?.successful)||0;
  const average=result?.averageMs;
  if(!successful||!Number.isFinite(average)||average<0){
    const timedOut=!result?.reason||/timed out/i.test(result.reason);
    return {latency:null,latencyStatus:timedOut?'timeout':'error',latencySuccess:0,latencyAttempted:attempted};
  }
  return {latency:Math.round(average),latencyStatus:successful<attempted?'partial':'ok',latencySuccess:successful,latencyAttempted:attempted};
}
export function latencyResponseCount(result) {
  const {latencyAttempted: attempted, latencySuccess: successful, provisional} = result;
  if (provisional || ![2, 3].includes(attempted) ||
      !Number.isInteger(successful) || successful < 0 || successful > attempted) return '';
  return `${successful}/${attempted}`;
}

export function speedCandidates(servers, pingResults) {
  const reachable = servers.map(server => ({server, latency: pingResults.get(server.id)}))
    .filter(({latency}) => Number.isFinite(latency))
    .sort((a, b) => a.latency - b.latency);
  return {
    count: reachable.length,
    candidates: reachable.slice(0, MAX_SPEED_SERVERS).map(({server}) => server),
  };
}

export async function pingPool(servers,samples,runOne,onProgress,{concurrency=3,shouldStop=()=>false}={}){
  if(![1,2,3].includes(samples))throw new Error('Ping count must be 1, 2 or 3');
  const list=[...servers];let next=0,finished=0;
  const workers=Array.from({length:Math.min(concurrency,list.length)},async()=>{
    while(!shouldStop()){
      const index=next++;if(index>=list.length)break;
      const server=list[index];let result;
      try{result=normalizedLatencyResult(await runOne(server,samples),samples)}
      catch(error){
        const cancelled = shouldStop() || (error?.message ?? error) === 'Test cancelled';
        result={latency:null,latencyStatus:cancelled?'cancelled':'start-failed',latencySuccess:0,latencyAttempted:0};
      }
      if (result.latencyStatus !== 'cancelled') finished++;
      onProgress?.(server,result,finished,list.length);
    }
  });
  await Promise.all(workers);
  return {finished,total:list.length,cancelled:shouldStop()};
}
