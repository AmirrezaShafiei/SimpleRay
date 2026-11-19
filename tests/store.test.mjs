import test from 'node:test';
import assert from 'node:assert/strict';
import {createRepository,STORAGE_KEY} from '../frontend/store.js';
const uuid='11111111-2222-4333-8444-555555555555';
const line=(host,name='Server')=>`vless://${uuid}@${host}:443?security=tls#${name}`;
const memory=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),dump:()=>map}};
const repository=storage=>createRepository(storage||memory());

test('manual import persists after restart, and duplicates are deduped',()=>{
 const storage=memory(),a=repository(storage);a.importManual([line('a.test'),line('a.test'),line('b.test')].join('\n'));
 assert.equal(a.rows().length,2);assert.equal(a.rows()[0].source,'—');
 assert.equal(repository(storage).rows().length,2);
});
test('subscription naming, renamed Source, favorites, IDs and selection survive refresh',()=>{
 const storage=memory(),a=repository(storage);const sub=a.addSubscription('Daily Nodes','https://example.org/sub?key=abc');
 let r=a.refreshSubscription(sub.id,[line('a.test','A'),line('b.test','B')].join('\n'));
 assert.deepEqual([r.added,r.retained,r.removed],[2,0,0]);
 const id=a.rows()[0].id;a.toggleFavorite(id);a.setSelected(id);
 r=a.refreshSubscription(sub.id,[line('a.test','Renamed A'),line('c.test','C')].join('\n'));
 assert.deepEqual([r.added,r.retained,r.removed],[1,1,1]);
 assert.equal(a.rows()[0].id,id);assert.equal(a.rows()[0].favorite,true);assert.equal(a.snapshot().selectedId,id);
 a.renameSubscription(sub.id,'Private Servers');assert.ok(a.rows().every(s=>s.source==='Private Servers'));
 assert.ok(repository(storage).rows().every(s=>s.source==='Private Servers'));
});
test('failed or empty subscription update leaves last-good nodes',()=>{
 const a=repository(),sub=a.addSubscription('Daily','https://example.com/sub');
 a.refreshSubscription(sub.id,line('a.test'));
 assert.throws(()=>a.refreshSubscription(sub.id,'invalid://bad'));
 assert.equal(a.rows().length,1);
 a.setSubscriptionError(sub.id,'Network timeout');assert.equal(a.snapshot().subscriptions[0].lastError,'Network timeout');
});
test('deleting subscription nodes persists as hidden across updates',()=>{
 const a=repository(),sub=a.addSubscription('Daily','https://example.com/sub');
 a.refreshSubscription(sub.id,[line('a.test'),line('b.test')].join('\n'));
 const id=a.rows()[0].id;a.deleteServer(id);a.refreshSubscription(sub.id,[line('a.test'),line('b.test')].join('\n'));
 assert.equal(a.rows().length,1);assert.notEqual(a.rows()[0].id,id);
});
test('duplicate subscription item becomes standalone editable item',()=>{
 const a=repository(),sub=a.addSubscription('Daily','https://example.com/sub');a.refreshSubscription(sub.id,line('a.test'));
 a.duplicateManual(a.rows()[0].id);
 const manual=a.rows().find(s=>s.source==='—');assert.equal(manual.subscriptionId,null);
 a.updateManual(manual.id,line('other.test'),'Manual Name');assert.equal(a.rows().find(s=>s.id===manual.id).name,'Manual Name');
});
test('deleting subscription optionally keeps nodes as manual',()=>{
 const a=repository(),sub=a.addSubscription('Daily','https://example.com/sub');a.refreshSubscription(sub.id,line('a.test'));a.deleteSubscription(sub.id,{keepNodes:true});
 assert.equal(a.rows()[0].source,'—');assert.equal(a.snapshot().subscriptions.length,0);
});
test('save failures do not mutate in-memory state',()=>{
 const storage={getItem:()=>null,setItem:()=>{throw new Error('quota')}};const a=repository(storage);
 assert.throws(()=>a.addSubscription('Daily','https://example.com/sub'),/Unable to save/);
 assert.equal(a.snapshot().subscriptions.length,0);
});
test('corrupt storage is not automatically overwritten',()=>{
 const storage=memory();storage.setItem(STORAGE_KEY,'{bad-json');const a=repository(storage);
 assert.ok(a.loadError);assert.throws(()=>a.addSubscription('Daily','https://example.com/sub'),/read-only/);
 assert.equal(storage.getItem(STORAGE_KEY),'{bad-json');
});

test('three pins persist and follow subscription entries across refresh',()=>{
 const storage=memory(),a=repository(storage);
 a.importManual(['a','b','c'].map(name=>line(name+'.test')).join('\n'));
 const sub=a.addSubscription('Daily','https://example.com/sub');
 a.refreshSubscription(sub.id,line('d.test'));
 const [first,second,third,subscribed]=a.rows();
 for(const row of [first,second,subscribed])a.togglePin(row.id);
 assert.throws(()=>a.togglePin(third.id),/Up to 3/);
 a.refreshSubscription(sub.id,line('d.test','Renamed'));
 assert.equal(repository(storage).rows().find(row=>row.id===subscribed.id).pinned,true);
 a.togglePin(first.id);
 a.togglePin(third.id);
 assert.equal(a.rows().filter(row=>row.pinned).length,3);
});

test('phone import reuses a renamed or reordered subscription configuration and preserves the record',()=>{
 const a=repository(),sub=a.addSubscription('Daily','https://example.com/sub');
 const original=`vless://${uuid}@a.test:443?security=tls&type=ws&path=%2Ftest#Old`;
 a.refreshSubscription(sub.id,original);
 const [{id}]=a.rows();
 a.togglePin(id);
 a.setLatency(id,{latency:301,latencyStatus:'ok',latencySuccess:3,latencyAttempted:3});
 const before=a.snapshot();
 const received=a.receiveFromPhone(`vless://${uuid}@a.test:443?path=%2Ftest&type=ws&security=tls#New`);
 assert.equal(received.id,id);
 assert.equal(received.duplicate,true);
 assert.deepEqual(a.snapshot(),before);

 const distinct=a.receiveFromPhone(original.replace('%2Ftest','%2Fother'));
 assert.equal(distinct.duplicate,false);
 assert.notEqual(distinct.id,id);
 assert.equal(a.rows().length,2);
 assert.throws(()=>a.receiveFromPhone('https://example.com/sub'));
 assert.equal(a.rows().length,2);
});
