export const THEME_MODES=['system','light','dark','custom'];
export const THEME_COLORS={primary:'#245995',accent:'#3eadef'};
export function themeColor(input,fallback){
  return /^#[0-9a-f]{6}$/i.test(input??'')?input:fallback;
}
export function customScheme(primary){
  const components=[1,3,5].map(index=>{
    const channel=parseInt(primary.slice(index,index+2),16)/255;
    return channel<=0.04045?channel/12.92:((channel+0.055)/1.055)**2.4;
  });
  const luminance=components[0]*0.2126+components[1]*0.7152+components[2]*0.0722;
  return luminance>=0.36?'light':'dark';
}
