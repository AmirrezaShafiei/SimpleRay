function hslToHex(h,s,l){
  const a=s*Math.min(l,1-l);
  const channel=n=>{
    const k=(n+h/30)%12;
    return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');
  };
  return '#'+[0,8,4].map(channel).join('');
}
function colorPosition(hex){
  const [r,g,b]=[1,3,5].map(offset=>parseInt(hex.slice(offset,offset+2),16)/255);
  const hi=Math.max(r,g,b),lo=Math.min(r,g,b),delta=hi-lo,l=(hi+lo)/2;
  if(!delta)return {h:0,s:0,l};
  const sector=hi===r?(g-b)/delta:hi===g?(b-r)/delta+2:(r-g)/delta+4;
  return {h:(sector*60+360)%360,s:delta/(1-Math.abs(2*l-1)),l};
}
export function attachColorWheel({canvas,target,lightness,read,write,commit}){
  const ctx=canvas.getContext('2d');
  const size=canvas.width,center=size/2,radius=center-5;
  let image,atLightness,dragging=false;
  function refresh(){
    const color=colorPosition(read(target.value));
    lightness.value=String(Math.round(color.l*100));
    const wheelLightness=Math.round(color.l*100)/100;
    if(atLightness!==wheelLightness){
      image=ctx.createImageData(size,size);
      for(let y=0;y<size;y++)for(let x=0;x<size;x++){
        const dx=x-center,dy=y-center,distance=Math.hypot(dx,dy);
        if(distance>radius)continue;
        const angle=(Math.atan2(dy,dx)*180/Math.PI+360)%360;
        const hex=hslToHex(angle,distance/radius,wheelLightness);
        const i=(y*size+x)*4;
        for(let c=0;c<3;c++)image.data[i+c]=parseInt(hex.slice(1+c*2,3+c*2),16);
        image.data[i+3]=255;
      }
      atLightness=wheelLightness;
    }
    ctx.putImageData(image,0,0);
    const angle=color.h*Math.PI/180;
    ctx.beginPath();
    ctx.arc(center+Math.cos(angle)*radius*color.s,center+Math.sin(angle)*radius*color.s,5,0,Math.PI*2);
    ctx.lineWidth=3;ctx.strokeStyle='#222';ctx.stroke();
    ctx.lineWidth=1.5;ctx.strokeStyle='#fff';ctx.stroke();
  }
  function pick(event){
    const box=canvas.getBoundingClientRect();
    const x=(event.clientX-box.left)*size/box.width-center;
    const y=(event.clientY-box.top)*size/box.height-center;
    write(target.value,hslToHex((Math.atan2(y,x)*180/Math.PI+360)%360,Math.min(1,Math.hypot(x,y)/radius),Number(lightness.value)/100));
  }
  canvas.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    dragging=true;canvas.setPointerCapture(event.pointerId);pick(event);
  });
  canvas.addEventListener('pointermove',event=>{if(dragging)pick(event)});
  canvas.addEventListener('lostpointercapture',()=>{dragging=false;commit()});
  lightness.addEventListener('change',commit);
  target.addEventListener('change',refresh);
  lightness.addEventListener('input',()=>{
    const {h,s}=colorPosition(read(target.value));
    write(target.value,hslToHex(h,s,Number(lightness.value)/100));
  });
  return {refresh};
}
