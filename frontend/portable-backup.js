import {parseShareLink, validateSubscriptionUrl} from './config.js';
import {MAX_PINNED_SERVERS} from './store.js';

const FORMAT = 'simpleray.backup';
const VERSION = 1;
const MAX_SIZE = 25_000_000;

export function createPortableBackup({servers, subscriptions, selectedId}) {
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    profiles: {
      selectedId,
      servers: servers.map(({id, name, uri, subscriptionId, favorite, pinned, localName}) =>
        ({id, name, uri, subscriptionId:subscriptionId ?? null, favorite:!!favorite, pinned:!!pinned, localName})),
      subscriptions: subscriptions.map(({id, name, url, autoRefreshHours, updatedAt, lastAttemptAt, hiddenSignatures}) =>
        ({id, name, url, autoRefreshHours, updatedAt, lastAttemptAt, hiddenSignatures})),
    },
  });
}

export function readPortableBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_SIZE) throw new Error('Backup file is too large.');
  let document;
  try { document = JSON.parse(text); }
  catch { throw new Error('Could not read this SimpleRAY backup.'); }
  if (document?.format !== FORMAT) throw new Error('Choose a SimpleRAY backup file.');
  if (document.version !== VERSION) throw new Error('This backup version is unsupported.');

  const source = document.profiles;
  if (!Array.isArray(source?.servers) || source.servers.length > 15000
      || !Array.isArray(source?.subscriptions) || source.subscriptions.length > 1000)
    throw new Error('The backup profile list is invalid.');

  const subscriptionIds = new Set(), urls = new Set(), serverIds = new Set();
  const invalid = () => { throw new Error('The backup contains an invalid server or subscription.'); };
  function addId(ids, id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 160 || ids.has(id)) invalid();
    ids.add(id);
    return id;
  }
  function nameOf(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 160) invalid();
    return name;
  }
  function dateOf(value) {
    return typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value)) ? value : null;
  }

  const subscriptions = source.subscriptions.map(item => {
    if (!item || typeof item.url !== 'string') invalid();
    let url;
    try { url = validateSubscriptionUrl(item.url); } catch { invalid(); }
    if (urls.has(url)) invalid();
    urls.add(url);
    const hidden = item.hiddenSignatures ?? [];
    if (!Array.isArray(hidden) || hidden.length > 15000
        || hidden.some(value => typeof value !== 'string' || !value || value.length > 160)) invalid();
    const autoRefreshHours = item.autoRefreshHours ?? 0;
    if (![0, 6, 24].includes(autoRefreshHours)) invalid();
    return {id:addId(subscriptionIds, item.id), name:nameOf(item.name), url, autoRefreshHours,
      updatedAt:dateOf(item.updatedAt), lastAttemptAt:dateOf(item.lastAttemptAt), lastError:null,
      hiddenSignatures:[...new Set(hidden)]};
  });
  const servers = source.servers.map(item => {
    if (!item || typeof item.uri !== 'string') invalid();
    const subscriptionId = item.subscriptionId ?? null;
    if (subscriptionId !== null && !subscriptionIds.has(subscriptionId)) invalid();
    let link;
    try { link = parseShareLink(item.uri); } catch { invalid(); }
    const server = {...link, id:addId(serverIds, item.id), name:nameOf(item.name), subscriptionId,
      favorite:item.favorite === true, pinned:item.pinned === true};
    if (item.localName != null) server.localName = nameOf(item.localName);
    return server;
  });
  if (servers.filter(server => server.pinned).length > MAX_PINNED_SERVERS) invalid();
  return {servers, subscriptions, selectedId:serverIds.has(source.selectedId) ? source.selectedId : servers[0]?.id ?? null};
}
