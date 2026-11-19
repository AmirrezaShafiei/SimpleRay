import {COUNTRIES} from './countries.js';

const regionA=0x1f1e6;
const indices=new Map(Object.keys(COUNTRIES).map((code,index)=>[code,index]));
const names=new Map(Object.entries(COUNTRIES).map(([code,name])=>[name.toLowerCase(),code]));
for(const [name,code] of [
  ['turkey','tr'],['türkiye','tr'],['ایران','ir'],['usa','us'],['united states','us'],
  ['uk','gb'],['great britain','gb'],['uae','ae'],['south korea','kr'],['north korea','kp']
])names.set(name,code);
const byName=[...names].sort(([a],[b])=>b.length-a.length);
const normalize=text=>String(text??'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();

const flagEmoji=/[🇦-🇿]{2}/u;

function fromEmoji(value){
  const pair=String(value??'').match(flagEmoji);
  if(!pair)return null;
  return Array.from(pair[0],letter=>String.fromCharCode(97+letter.codePointAt(0)-regionA)).join('');
}

export function countryOf(server){
  if(!server)return null;
  const explicit=String(server.countryCode??server.flag??'').toLowerCase();
  const fromFlag=fromEmoji(server.flag)??fromEmoji(server.name);
  if(Object.hasOwn(COUNTRIES,fromFlag))return fromFlag;
  if(Object.hasOwn(COUNTRIES,explicit))return explicit;
  const label=normalize(server.name);
  const code=label.match(/^([A-Z]{2})(?: |$)/)?.[1]?.toLowerCase();
  if(code!=='ss'&&Object.hasOwn(COUNTRIES,code))return code;
  const padded=` ${label.toLowerCase()} `;
  return byName.find(([name])=>padded.includes(` ${normalize(name)} `))?.[1]??null;
}

export function displayServerName(server){
  const name=String(server.name??'');
  return name.replace(flagEmoji,'').trim()||name;
}

export function renderFlag(container,server,fallback){
  const code=countryOf(server);
  if(container.dataset.country===(code??''))return;
  container.dataset.country=code??'';
  if(!code){container.innerHTML=fallback;container.removeAttribute('title');return}
  const index=indices.get(code);
  const flag=document.createElement('span');
  flag.className='flag-image';
  flag.style.backgroundPosition=`${-(index%16)*20}px ${-Math.floor(index/16)*15}px`;
  flag.setAttribute('role','img');
  flag.setAttribute('aria-label',COUNTRIES[code]);
  container.title=COUNTRIES[code];
  container.replaceChildren(flag);
}
