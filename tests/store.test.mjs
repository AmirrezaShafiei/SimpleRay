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
test('manual update restores previously deleted subscription nodes after restart',()=>{
 const storage=memory(),a=repository(storage);
 const sub=a.addSubscription('Daily','https://example.com/sub');
 const other=a.addSubscription('Other','https://example.com/other');
 const payload=[line('a.test'),line('b.test')].join('\n');
 a.refreshSubscription(sub.id,payload);
 a.refreshSubscription(other.id,line('other.test'));
 a.importManual(line('manual.test'));
 const [first,second,otherServer,manual]=a.rows();
 a.toggleFavorite(second.id);
 a.setSelected(first.id);
 assert.throws(()=>a.deleteServers([first.id,'missing']), /Server not found/);
 assert.equal(a.snapshot().selectedId,first.id);
 a.deleteServers([first.id,otherServer.id,manual.id]);
 assert.equal(a.snapshot().selectedId,second.id);

 const reloaded=repository(storage);
 reloaded.refreshSubscription(sub.id,payload);
 assert.deepEqual(reloaded.rows().map(server=>server.id),[second.id]);
 assert.throws(()=>reloaded.refreshSubscription(sub.id,'unusable',undefined,{restoreDeleted:true}));
 assert.equal(reloaded.snapshot().subscriptions[0].hiddenSignatures.length,1);
 const result=reloaded.refreshSubscription(sub.id,payload,undefined,{restoreDeleted:true});
 assert.equal(result.restored,1);
 assert.equal(reloaded.rows().find(server=>server.id===second.id).favorite,true);
 assert.deepEqual(reloaded.rows().map(server=>server.host).sort(),['a.test','b.test']);
 reloaded.refreshSubscription(other.id,line('other.test'));
 assert.equal(reloaded.rows().length,2);
 assert.equal(reloaded.snapshot().subscriptions[0].hiddenSignatures.length,0);
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

test('inline rename is a local override retained by subscription refresh',()=>{
  const storage={getItem:()=>null,setItem:()=>{}};
  const repo=createRepository(storage);
  const sub=repo.addSubscription('Test source','https://example.org/sub');
  const uri='vless://11111111-2222-4333-8444-555555555555@server.test:443?security=tls';
  repo.refreshSubscription(sub.id,uri+'#Provider');
  const entry=repo.rows()[0];
  repo.renameServer(entry.id,'My alias');
  repo.refreshSubscription(sub.id,uri+'#Changed');
  const renamed=repo.rows()[0];
  assert.equal(renamed.id,entry.id);
  assert.equal(renamed.name,'My alias');
  assert.equal(renamed.uri,uri+'#Changed');
});

test('editing an existing subscription URL preserves its last-good nodes and favorites',()=>{
  const storage = memory();
  const repo = repository(storage);
  const sub = repo.addSubscription('Daily', 'https://example.org/old');
  repo.refreshSubscription(sub.id, line('a.test', 'First'));
  const {id} = repo.rows()[0];
  repo.toggleFavorite(id);
  repo.setSelected(id);

  const edited = repo.editSubscription(sub.id, {name:'Daily', url:'https://example.org/new', autoRefreshHours:6});
  assert.equal(edited.urlChanged, true);
  assert.equal(edited.subscription.id, sub.id);
  assert.equal(repo.rows()[0].favorite, true);
  assert.throws(() => repo.refreshSubscription(sub.id, 'unusable'));
  assert.equal(repo.rows()[0].id, id);

  const reloaded = repository(storage);
  assert.equal(reloaded.snapshot().subscriptions[0].url, 'https://example.org/new');
  const stats = reloaded.refreshSubscription(sub.id, line('a.test', 'Renamed'));
  assert.equal(stats.retained, 1);
  assert.equal(reloaded.rows()[0].favorite, true);
  assert.equal(reloaded.snapshot().selectedId, id);

  const another = reloaded.addSubscription('Another', 'https://example.org/another');
  assert.throws(() => reloaded.editSubscription(another.id, {name:'Another', url:'https://example.org/new'}), /already saved/);
  assert.throws(() => reloaded.editSubscription(sub.id, {name:'Daily', url:'https://example.org/new', autoRefreshHours:9}), /Invalid/);
});

test('auto-update is opt-in and a failed attempt defers the next scheduled refresh',()=>{
  const storage = memory();
  const repo = repository(storage);
  const now = Date.parse('2026-11-20T12:00:00.000Z');
  const iso = time => new Date(time).toISOString();
  const hour = 3_600_000;
  const manual = repo.addSubscription('Manual', 'https://example.org/manual');
  const everySix = repo.addSubscription('Six', 'https://example.org/six', 6);
  const daily = repo.addSubscription('Daily', 'https://example.org/daily', 24);
  repo.refreshSubscription(manual.id, line('manual.test'), iso(now - 48 * hour));
  repo.refreshSubscription(everySix.id, line('six.test'), iso(now - 7 * hour));
  repo.refreshSubscription(daily.id, line('day.test'), iso(now - 10 * hour));
  assert.deepEqual(repo.dueSubscriptions(now).map(item => item.id), [everySix.id]);

  repo.setSubscriptionError(everySix.id, 'Network timeout', iso(now));
  const reloaded = repository(storage);
  assert.equal(reloaded.rows().find(server => server.subscriptionId === everySix.id).name, 'Server');
  assert.deepEqual(reloaded.dueSubscriptions(now + 5 * hour), []);
  assert.deepEqual(reloaded.dueSubscriptions(now + 6 * hour).map(item => item.id), [everySix.id]);
  assert.deepEqual(reloaded.dueSubscriptions(now + 14 * hour).map(item => item.id), [everySix.id, daily.id]);
});
