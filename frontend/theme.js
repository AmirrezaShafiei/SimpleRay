export const APPEARANCE_KEY='simpleray.phase1.preferences.v1';
export const APPEARANCE_MODES=['system','light','dark'];
export const THEME_PALETTES=['ocean','jade','violet','custom'];
export const THEME_COLORS={primary:'#245995',accent:'#3eadef'};

export function themeColor(input,fallback){
  return /^#[0-9a-f]{6}$/i.test(input??'')?input:fallback;
}

// Beta 6 derived the Custom light/dark mode from its primary color.
function legacyCustomMode(primary){
  const components=[1,3,5].map(index=>{
    const channel=parseInt(primary.slice(index,index+2),16)/255;
    return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;
  });
  const luminance=components[0]*0.2126+components[1]*0.7152+components[2]*0.0722;
  return luminance>=0.36?'light':'dark';
}

export function savedPreferences(storage){
  try{return JSON.parse(storage.getItem(APPEARANCE_KEY)||'{}')??{}}catch{return {}}
}

export function restoreAppearance(saved){
  const themePrimary=themeColor(saved.themePrimary,THEME_COLORS.primary);
  const themeAccent=themeColor(saved.themeAccent,THEME_COLORS.accent);
  const palette=THEME_PALETTES.includes(saved.palette)?saved.palette:saved.theme==='custom'?'custom':'ocean';
  const appearance=APPEARANCE_MODES.includes(saved.appearance)?saved.appearance:
    APPEARANCE_MODES.includes(saved.theme)?saved.theme:saved.theme==='custom'?legacyCustomMode(themePrimary):'system';
  return {palette,appearance,themePrimary,themeAccent};
}

export function paintAppearance(root,appearance,systemLight){
  root.dataset.theme=appearance.appearance==='system'?(systemLight?'light':'dark'):appearance.appearance;
  root.dataset.palette=appearance.palette;
  root.style.setProperty('--custom-primary',appearance.themePrimary);
  root.style.setProperty('--custom-accent',appearance.themeAccent);
}
