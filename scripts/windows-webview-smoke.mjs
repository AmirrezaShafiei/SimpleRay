import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';

const port=Number(process.argv[2]);
assert.ok(Number.isInteger(port)&&port>0&&port<65536);

async function waitFor(check,message,timeoutMs=5000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    const result=await check();
    if(result)return result;
    await sleep(100);
  }
  assert.fail(message);
}

async function withWebView(paths,run){
  const target=await waitFor(async()=>{
    try{
      const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(600)});
      const pages=await response.json();
      return pages.find(page=>paths.includes(new URL(page.url).pathname));
    }catch{}
  },'Missing installed WebView for '+paths.join(', '),15000);
  const socket=new WebSocket(target.webSocketDebuggerUrl);
  let requestId=0;
  const pending=new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    pending.get(message.id)?.(message);
  });
  async function call(method,params){
    const id=++requestId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('WebView debugger timed out: '+method))},5000);
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
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('WebView debugger did not open')),4000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Cannot open the WebView debugger'))},{once:true});
    });
    await run({call,evaluate});
  }finally{
    socket.close();
  }
}

await withWebView(['/tray-panel.html'],async({call,evaluate})=>{
  await call('Emulation.setDeviceMetricsOverride',{width:356,height:370,deviceScaleFactor:1,mobile:false});
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
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
});

// Accept the SOCKS5 handshake and keep the tunnel open without replying to TLS.
// Both Xray probes are observable locally without using public test servers.
async function stalledProxy(){
  const reviews=[];
  const sockets=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);
    socket.on('close',()=>sockets.delete(socket));
    socket.on('error',()=>socket.destroy());
    let authenticated=false;
    let request=Buffer.alloc(0);
    socket.on('data',function handshake(bytes){
      request=Buffer.concat([request,bytes]);
      if(!authenticated){
        if(request.length<2||request.length<2+request[1])return;
        request=request.subarray(2+request[1]);
        authenticated=true;
        socket.write(Buffer.from([5,0]));
      }
      if(request.length<5)return;
      const size=request[3]===1?4:request[3]===4?16:request[4]+1;
      if(request.length<6+size)return;
      const host=request[3]===3?request.subarray(5,4+size).toString():null;
      reviews.push({host,time:Date.now(),socket});
      socket.removeListener('data',handshake);
      socket.resume();
      socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));
    });
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {
    port:server.address().port,reviews,sockets,
    close(){for(const socket of sockets)socket.destroy();server.close()},
  };
}

const first=await stalledProxy();
const second=await stalledProxy();
try{
  await withWebView(['/','/index.html'],async({evaluate})=>{
    const switchSnapshot=`(()=>{
      const button=document.querySelector('#connectionSwitch');
      const thumb=button.querySelector('.toggle-thumb');
      return {
        state:document.querySelector('#connectionState').textContent,
        label:button.getAttribute('aria-label'),
        checked:button.getAttribute('aria-checked'),
        title:button.title,
        text:button.textContent.trim(),
        disabled:button.disabled,
        thumbVisible:getComputedStyle(thumb).display!=='none',
        hatch:getComputedStyle(thumb,'::after').backgroundImage.startsWith('repeating-linear-gradient'),
        target:document.querySelector('#selectedText').textContent,
      };
    })()`;
    const clickSwitch=()=>evaluate("document.querySelector('#connectionSwitch').click()");
    const state=()=>evaluate(switchSnapshot);
    await waitFor(()=>evaluate("document.readyState==='complete' && !!document.querySelector('#connectionSwitch')"),'Main window did not finish loading');
    await evaluate(`(()=>{
      const add=(name,port)=>{
        document.querySelector('#manualAddButton').click();
        document.querySelector('#manualUri').value='socks5://127.0.0.1:'+port;
        document.querySelector('#manualName').value=name;
        document.querySelector('#manualForm').requestSubmit();
      };
      add('Connection test A',${first.port});
      add('Connection test B',${second.port});
    })()`);
    const idle=await state();
    assert.equal(idle.state,'Disconnected');
    assert.equal(idle.checked,'false');
    assert.equal(idle.hatch,false);
    assert.equal(idle.disabled,false);
    assert.match(idle.target,/Connection test A/);
    await clickSwitch();
    const connecting=await state();
    assert.equal(connecting.state,'Connecting…');
    assert.equal(connecting.label,'Cancel connection');
    assert.equal(connecting.title,'Cancel connection');
    assert.equal(connecting.text,'');
    assert.equal(connecting.disabled,false);
    assert.equal(connecting.thumbVisible,true);
    assert.equal(connecting.hatch,true);
    const primary=await waitFor(()=>first.reviews.find(r=>r.host==='www.cloudflare.com'),'Primary connection probe did not start');
    const backup=await waitFor(()=>first.reviews.find(r=>r.host==='www.gstatic.com'),'Backup connection probe did not start');
    assert.ok(backup.time-primary.time>=1500,'The second endpoint started too early');
    assert.ok(first.sockets.has(primary.socket),'The first probe stopped when the second began');
    const afterClick=await evaluate(`(()=>{
      document.querySelector('#connectionSwitch').click();
      return ${switchSnapshot};
    })()`);
    assert.equal(afterClick.state,'','The status text must be blank until cancellation finishes');
    assert.equal(afterClick.hatch,false,'The hatch must disappear on the cancel click');
    assert.equal(afterClick.disabled,true,'The switch must wait for Xray cancellation to finish');
    const cancelled=await waitFor(async()=>{
      const current=await state();
      return current.state==='Disconnected'&&current;
    },'Clicking the hatched switch did not cancel');
    assert.equal(cancelled.checked,'false');
    assert.equal(cancelled.hatch,false);
    assert.equal(cancelled.thumbVisible,true);
    await waitFor(()=>first.sockets.size===0,'Cancelled Xray still holds its tunnel open');

    await clickSwitch();
    await waitFor(()=>first.sockets.size>0,'The next connection attempt did not start');
    await evaluate(`(()=>{
      const row=[...document.querySelectorAll('#serverRows tr')].find(item=>item.textContent.includes('Connection test B'));
      row.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));
    })()`);
    const replacement=await waitFor(()=>second.reviews[0],'The selected replacement server did not start');
    assert.match((await state()).target,/Connection test B/);
    await waitFor(()=>first.sockets.size===0,'The superseded server is still probing');
    const timedOut=await waitFor(async()=>{
      const current=await state();
      return current.state==='Disconnected'&&current;
    },'The connection confirmation window did not end',14500);
    const elapsed=Date.now()-replacement.time;
    assert.ok(elapsed>=10500&&elapsed<=14500,'Unexpected confirmation time: '+elapsed+' ms');
    assert.match(await evaluate("document.querySelector('#toast').textContent"),/timed out/i);
    assert.equal(timedOut.hatch,false);
    await waitFor(()=>second.sockets.size===0,'The timed-out Xray still holds its tunnel open');
    console.log('Installed Windows connection: hatched switch, cancellation, staggered probes, replacement and timeout passed');
  });
}finally{
  first.close();
  second.close();
}
