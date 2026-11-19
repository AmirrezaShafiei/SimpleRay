export const PREFERENCES_KEY='simpleray.phase1.preferences.v1';
export const PALETTES=Object.freeze({ocean:{primary:'#267ad8',accent:'#33b9f4'},forest:{primary:'#167d66',accent:'#29d9a0'},violet:{primary:'#754bd9',accent:'#b18aff'}});
const color=(v,f)=>typeof v==='string'&&/^#[\da-f]{6}$/i.test(v)?v.toLowerCase():f;
export function readAppearance(storage){
 let p={};try{p=JSON.parse(storage.getItem(PREFERENCES_KEY)||'{}')||{}}catch{}
 return {mode:['light','dark','system'].includes(p.theme)?p.theme:'system',palette:p.palette==='custom'||Object.hasOwn(PALETTES,p.palette)?p.palette:'ocean',primary:color(p.customPrimary,'#317de4'),accent:color(p.customAccent,'#23c3c7')};
}
export function applyAppearance(root,pref,systemLight=false){
 const actual=pref.mode==='system'?(systemLight?'light':'dark'):pref.mode;
 const colors=pref.palette==='custom'?{primary:color(pref.primary,'#317de4'),accent:color(pref.accent,'#23c3c7')}:PALETTES[pref.palette]||PALETTES.ocean;
 root.dataset.theme=actual;root.dataset.palette=pref.palette==='custom'||Object.hasOwn(PALETTES,pref.palette)?pref.palette:'ocean';
 root.style.setProperty('--theme-primary',colors.primary);root.style.setProperty('--theme-accent',colors.accent);
 return actual;
}
