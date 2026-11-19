import qrcode from './vendor/qrcode.js';

export function phoneTransferControls({invoke,showDialog,onReceive,onTest,onConnect}) {
  const get=id=>document.getElementById(id);
  const dialog=get('phoneTransferDialog');
  const qrPanel=get('phoneQrPanel');
  const qrImage=get('phoneQr');
  const address=get('phoneNetwork');
  const notice=get('phoneTransferStatus');
  const expiry=get('phoneTransferExpiry');
  const newCode=get('newPhoneCode');
  const connect=get('connectFromPhone');
  let generation=0;
  let invitation;
  let timer;
  let connectId;

  function status(message,kind='neutral') {
    notice.textContent=message;
    notice.dataset.kind=kind;
  }
  function hideCode() {
    qrPanel.hidden=true;
    qrImage.removeAttribute('src');
    get('phoneTransferUrl').value='';
    expiry.hidden=true;
  }
  function stop() {
    generation++;
    clearTimeout(timer);
    if(invitation)void invoke('cancel_phone_transfer',{id:invitation.id}).catch(()=>{});
    invitation=undefined;
    hideCode();
    connect.hidden=true;
    connectId=undefined;
  }
  function reset() {
    stop();
    newCode.disabled=true;
    address.disabled=true;
    status('Preparing the local receiver…');
    return generation;
  }
  function isCurrent(request) {
    return request===generation&&dialog.open;
  }
  function done() {
    newCode.disabled=false;
    address.disabled=false;
  }
  async function start(selection) {
    const request=reset();
    try {
      const addresses=await invoke('phone_transfer_addresses');
      if(!isCurrent(request))return;
      address.replaceChildren(...addresses.map(ip=>new Option(ip,ip)));
      get('phoneNetworkRow').hidden=addresses.length<=1;
      if(!addresses.length) {
        status('Connect to Wi-Fi or your phone’s hotspot, then choose New code.','error');
        return;
      }
      address.value=addresses.includes(selection)?selection:addresses[0];
      const next=await invoke('start_phone_transfer',{address:address.value});
      if(!isCurrent(request)) {
        void invoke('cancel_phone_transfer',{id:next.id}).catch(()=>{});
        return;
      }
      invitation=next;
      const qr=qrcode(0,'M');
      qr.addData(next.url);
      qr.make();
      qrImage.src=qr.createDataURL(5,20);
      get('phoneTransferUrl').value=next.url;
      qrPanel.hidden=false;
      expiry.hidden=false;
      status('Waiting for your phone…');
      void poll(request,Date.now()+next.expiresIn*1000);
    } catch(error) {
      if(isCurrent(request)) {
        stop();
        status(String(error?.message??error),'error');
        done();
      }
    } finally {
      if(isCurrent(request))done();
    }
  }
  async function poll(request,deadline) {
    const seconds=Math.max(0,Math.ceil((deadline-Date.now())/1000));
    expiry.textContent=`Code expires in ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
    try {
      const receipt=await invoke('poll_phone_transfer',{id:invitation.id});
      if(!isCurrent(request))return;
      if(receipt.status==='waiting'&&seconds>0) {
        timer=setTimeout(()=>void poll(request,deadline),600);
      } else if(receipt.status==='received') {
        hideCode();
        const result=onReceive(receipt.link);
        status(result.duplicate?'Already saved. Testing the existing server…':'Server added. Testing from this computer…');
        const latency=await onTest(result);
        if(!isCurrent(request))return;
        const prefix=result.duplicate?'Existing server':'New server';
        if(Number.isFinite(latency)) {
          status(`${prefix} responded in ${latency} ms.`,'success');
          connectId=result.id;
          connect.hidden=false;
        }else {
          status(`${prefix} saved. The connection test did not get a response.`,'error');
        }
      } else {
        stop();
        status('The QR code expired. Choose New code to try again.');
      }
    } catch(error) {
      if(isCurrent(request)) {
        stop();
        status(String(error?.message??error),'error');
      }
    }
  }

  get('phoneTransferButton').addEventListener('click',()=>{
    showDialog('phoneTransferDialog');
    void start(address.value);
  });
  dialog.addEventListener('close',()=>{if(!dialog.open)stop()});
  address.addEventListener('change',()=>void start(address.value));
  newCode.addEventListener('click',()=>void start(address.value));
  get('phoneTransferUrl').addEventListener('focus',event=>event.target.select());
  connect.addEventListener('click',()=>{
    const id=connectId;
    dialog.close();
    if(id)onConnect(id);
  });
}
