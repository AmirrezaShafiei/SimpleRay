import test from 'node:test';
import assert from 'node:assert/strict';
import {countryOf,displayServerName} from '../frontend/flags.js';
import {paintAppearance,restoreAppearance,themeColor,THEME_PALETTES} from '../frontend/theme.js';
import {DEFAULT_PING_SAMPLES} from '../frontend/runtime.js';

test('find country flags from emoji, country code, and names without assuming a location',()=>{
 assert.equal(countryOf({name:'🇮🇷 Relay',flag:'🌐'}),'ir');
 assert.equal(displayServerName({name:'🇮🇷 Relay'}),'Relay');
 assert.equal(countryOf({name:'IR · Server 5'}),'ir');
 assert.equal(countryOf({name:'Turkey Tunnel'}),'tr');
 assert.equal(countryOf({name:'Relay',flag:'DE'}),'de');
 assert.equal(countryOf({name:'Fast Relay'}),null);
});
test('beta 6 appearance settings migrate with custom colors intact',()=>{
 assert.equal(restoreAppearance({theme:'dark'}).palette,'ocean');
 assert.equal(restoreAppearance({theme:'dark'}).appearance,'dark');
 assert.equal(restoreAppearance({theme:'custom',themePrimary:'#202035'}).appearance,'dark');
 assert.equal(restoreAppearance({theme:'custom',themePrimary:'#ffffff'}).appearance,'light');
 assert.equal(restoreAppearance({theme:'custom',themeAccent:'#aa0044'}).themeAccent,'#aa0044');
 assert.equal(themeColor('invalid','#000000'),'#000000');
});
test('every palette supports separate light, dark and system choices',()=>{
 for(const palette of THEME_PALETTES){
   const root={dataset:{},style:{setProperty(){}}};
   for(const [appearance,systemLight,expected] of [
     ['light',false,'light'],['dark',true,'dark'],['system',true,'light'],['system',false,'dark']
   ]){
     paintAppearance(root,restoreAppearance({palette,appearance}),systemLight);
     assert.deepEqual(root.dataset,{palette,theme:expected});
   }
 }
});
test('new settings default to two ping probes',()=>{
 assert.equal(DEFAULT_PING_SAMPLES,2);
});
