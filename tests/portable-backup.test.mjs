import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortableBackup, readPortableBackup} from '../frontend/portable-backup.js';
import {createRepository} from '../frontend/store.js';

const link = (host, name) => 'vless://12345678-abcd-abcd-abcd-123456789abc@' + host + ':443#' + name;
const repository = () => {
  let stored = '', next = 0;
  return createRepository({
    getItem:() => stored,
    setItem:(_key, value) => { stored = value; },
  }, {idFactory:() => 'id-' + ++next});
};

test('a portable backup restores profile metadata, hidden entries and selection', () => {
  const original = repository();
  original.importManual(link('manual.example.com', 'Manual'));
  const sub = original.addSubscription('Work', 'https://example.com/feed', 6);
  original.refreshSubscription(sub.id, [
    link('first.example.com', 'First'),
    link('second.example.com', 'Second'),
  ].join('\n'));
  const [first, second] = original.rows().filter(row => row.subscriptionId === sub.id);
  original.deleteServers([second.id]);
  original.renameServer(first.id, 'Preferred');
  original.toggleFavorite(first.id);
  original.togglePin(first.id);
  original.setSelected(first.id);

  const destination = repository();
  const file = createPortableBackup(original.snapshot());
  destination.restoreProfiles(readPortableBackup(file));

  assert.deepEqual(JSON.parse(createPortableBackup(destination.snapshot())), JSON.parse(file));
  const refreshed = destination.refreshSubscription(sub.id, link('second.example.com', 'Second'));
  assert.equal(refreshed.added, 0);
});

test('unsupported or inconsistent backup files leave the current repository intact', () => {
  const destination = repository();
  destination.importManual(link('manual.example.com', 'Manual'));
  const before = destination.snapshot();
  const file = JSON.parse(createPortableBackup(before));
  assert.throws(() => readPortableBackup(JSON.stringify({...file, version:2})), /unsupported/);
  file.profiles.servers.push({...file.profiles.servers[0]});
  assert.throws(() => destination.restoreProfiles(readPortableBackup(JSON.stringify(file))), /invalid server/);
  assert.deepEqual(destination.snapshot(), before);
});
