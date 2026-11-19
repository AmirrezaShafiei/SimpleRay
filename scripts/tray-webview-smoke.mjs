import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';

const port=Number(process.argv[2]);
assert.ok(Number.isInteger(port)&&port>0&&port<65536);
let target;
for(let attempt=0;attempt<50&&!target;attempt++){
  try{
    const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(600)});
    const pages=await response.json();
    target=pages.find(page=>new URL(page.url).pathname==='/tray-panel.html');
  }catch{}
  if(!target)await sleep(300);
}
assert.ok(target,'The installed app did not create the tray panel WebView');

const socket=new WebSocket(target.webSocketDebuggerUrl);
let requestId=0;
const pending=new Map();
socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data);
  pending.get(message.id)?.(message);
});
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Tray WebView debugger did not open')),4000);
    socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Cannot open the tray WebView debugger'))},{once:true});
  });
  async function call(method,params){
    const id=++requestId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Tray debugger timed out: '+method))},5000);
      pending.set(id,message=>{
        clearTimeout(timer);pending.delete(id);
        if(message.error)reject(new Error(message.error.message));else resolve(message.result);
      });
      socket.send(JSON.stringify({id,method,params}));
    });
  }
  async function evaluate(expression){
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    assert.ok(!result.exceptionDetails,result.exceptionDetails?.exception?.description);
    return result.result.value;
  }
  await call('Emulation.setDeviceMetricsOverride',{width:356,height:370,deviceScaleFactor:1,mobile:false});
  for(let attempt=0;attempt<30;attempt++){
    if(await evaluate('document.readyState === "complete" && !!document.querySelector("#trayOpen")'))break;
    await sleep(150);
  }
  const checks=await evaluate(`(()=>{
    const key='simpleray.configurations.v2';
    const previous=localStorage.getItem(key);
    const get=id=>document.getElementById(id);
    try{
      const servers=Array.from({length:6},(_,i)=>({
        id:String(i),name:i===1?'A very long server name which will definitely extend beyond its allocated space in the tray panel':'Test server '+i,
        type:'VLESS',latency:120+i,subscriptionId:null
      }));
      localStorage.setItem(key,JSON.stringify({version:2,servers,subscriptions:[],selectedId:'0'}));
      window.dispatchEvent(new StorageEvent('storage',{key}));
      const search=get('traySearch');
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));
      const rowFor=(text)=>[...get('trayRows').children].find(row=>row.textContent.includes(text));
      const longRow=rowFor('A very long server name');
      const longName=longRow.querySelector('.tray-name');
      longName.dispatchEvent(new PointerEvent('pointerenter'));
      const first=longRow.classList.contains('keyboard-selected');
      window.dispatchEvent(new CustomEvent('simpleray:tray-panel-snapshot',{detail:{
        connected:true, activeId:'0',serverId:'0',latencyMs:183,
        suggestion:{serverId:'4',candidateMs:80},
        appearance:{palette:'jade',appearance:'light',themePrimary:'#245995',themeAccent:'#3eadef'}
      }}));
      const list=get('trayServers');
      const footer=document.querySelector('.tray-footer').getBoundingClientRect();
      return {
        visibleRows:list.clientHeight/longRow.offsetHeight,canScroll:list.scrollHeight>list.clientHeight,
        footerGap:footer.top-list.getBoundingClientRect().bottom,footerBottom:footer.bottom,
        actions:[...document.querySelectorAll('.tray-footer button')].map(button=>button.textContent.trim()),
        suggestion:get('trayRows').firstElementChild.textContent,
        selectionStable:first&&longRow===rowFor('A very long server name')&&longRow.classList.contains('keyboard-selected'),
        marquee:getComputedStyle(longName.firstElementChild).animationName,
        palette:document.documentElement.dataset.palette,theme:document.documentElement.dataset.theme
      };
    }finally{
      if(previous===null)localStorage.removeItem(key);else localStorage.setItem(key,previous);
      window.dispatchEvent(new StorageEvent('storage',{key}));
    }
  })()`);
  assert.equal(checks.visibleRows,4);
  assert.ok(checks.canScroll);
  assert.ok(checks.footerGap<=8,'Unexpected gap between the server list and footer: '+checks.footerGap);
  assert.ok(checks.footerBottom<=370,'Footer is clipped');
  assert.deepEqual(checks.actions,['Open SimpleRAY','Exit']);
  assert.match(checks.suggestion,/Test server 4.*Suggested.*Switch/);
  assert.equal(checks.selectionStable,true);
  assert.equal(checks.marquee,'tray-name-pan');
  assert.equal(checks.theme,'light');
  assert.equal(checks.palette,'jade');
  console.log('Installed Windows tray WebView: four rows, scrolling, compact footer, Open/Exit, recommendation, stable keyboard choice, marquee and shared theme passed');
}finally{
  socket.close();
}
