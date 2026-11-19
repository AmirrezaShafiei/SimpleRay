import test from 'node:test';
import assert from 'node:assert/strict';
import {countryOf,displayServerName} from '../frontend/flags.js';
import {customScheme,themeColor} from '../frontend/theme.js';

test('find country flags from emoji, country code, and names without assuming a location',()=>{
 assert.equal(countryOf({name:'🇮🇷 Relay',flag:'🌐'}),'ir');
 assert.equal(displayServerName({name:'🇮🇷 Relay'}),'Relay');
 assert.equal(countryOf({name:'IR · Server 5'}),'ir');
 assert.equal(countryOf({name:'Turkey Tunnel'}),'tr');
 assert.equal(countryOf({name:'Relay',flag:'DE'}),'de');
 assert.equal(countryOf({name:'Fast Relay'}),null);
});
test('custom themes validate stored colors and choose a readable base',()=>{
 assert.equal(customScheme('#202035'),'dark');
 assert.equal(customScheme('#ffffff'),'light');
 assert.equal(themeColor('#aa0044','#000000'),'#aa0044');
 assert.equal(themeColor('invalid','#000000'),'#000000');
});
