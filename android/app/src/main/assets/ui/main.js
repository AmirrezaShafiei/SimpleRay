import {createRepository, STORAGE_KEY} from '../shared/store.js';
import {parseImport, validateSubscriptionUrl} from '../shared/config.js';
import {outboundFromShareLink} from '../shared/xray-config.js';
import {filterServers, sortServers} from '../shared/model.js';
import {countryOf, displayServerName} from '../shared/flags.js';
import {restoreAppearance, paintAppearance, THEME_PALETTES, APPEARANCE_MODES} from '../shared/theme.js';
import {attachColorWheel} from '../shared/color-wheel.js';

const $ = id => document.getElementById(id);
const native = window.SimpleRayNative;
const modelStorage = {
  getItem(key) { return native ? native.get(key === STORAGE_KEY ? 'config' : key) : localStorage.getItem(key); },
  setItem(key, value) {
    if (!native) localStorage.setItem(key, value);
    else if (!native.set(key === STORAGE_KEY ? 'config' : key, value)) throw new Error('Could not save your changes');
  },
};
const repo = createRepository(modelStorage);
const freshRouting = () => ({appMode:'all', apps:[], domains:[]});
function loadPreferences() {
  let saved = {};
  try { saved = JSON.parse(modelStorage.getItem('prefs') || '{}'); } catch {}
  return {
    ...restoreAppearance(saved),
    pings: [1,2,3].includes(saved.pings) ? saved.pings : 2,
    switching: ['off','suggest','automatic'].includes(saved.switching) ? saved.switching : 'off',
    switchSource: typeof saved.switchSource === 'string' ? saved.switchSource : 'favorites',
    sort: ['favorite','name','type','latency','source'].includes(saved.sort) ? saved.sort : null,
    direction: saved.direction === 'desc' ? 'desc' : 'asc',
    autoConnect: !!saved.autoConnect,
    wifiRefresh: !!saved.wifiRefresh,
    routing: saved.routing?.domains && saved.routing?.apps ? saved.routing : freshRouting(),
  };
}
const preferences = loadPreferences();
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const colorProbe = document.createElement('canvas');
colorProbe.width = colorProbe.height = 1;
const colorContext = colorProbe.getContext('2d', {willReadFrequently:true});
let systemDark = systemTheme.matches;
let db = repo.snapshot();
let records = repo.rows();
let state = {phase:'disconnected'};
let filter = 'all', source = '', query = '', selection = new Set(), limit = 120;
let pings = new Map(), stableScores = new Map(), measuring = new Set(), lastPingToken = 0;
let shareQueue = [];
let toastTimer;
let closingTimer;
let pendingUntil = 0;
let detailsOpened = false;
let downloadResult = null;
const refreshing = new Set();
const replies = new Map();
let replyId = 0;

function fire(action, data = {}) { native?.request('', action, JSON.stringify(data)); }
function request(action, data = {}) {
  if (!native) {
    if (action === 'clipboard') return navigator.clipboard?.readText().catch(() => '') ?? Promise.resolve('');
    if (action === 'apps') return Promise.resolve([]);
    return Promise.reject(new Error('This action is available in the Android app'));
  }
  return new Promise((resolve, reject) => {
    const id = String(++replyId);
    const timer = setTimeout(() => {
      replies.delete(id);
      reject(new Error('The action timed out'));
    }, 75_000);
    replies.set(id, {resolve, reject, timer});
    native.request(id, action, JSON.stringify(data));
  });
}
window.receiveNative = raw => {
  const {type, value} = JSON.parse(raw);
  if (type === 'response') {
    const reply = replies.get(value.id);
    if (!reply) return;
    replies.delete(value.id);
    clearTimeout(reply.timer);
    if (value.error) reply.reject(new Error(value.error));
    else reply.resolve(value.result);
  } else if (type === 'import') {
    importPayload(value, true);
  } else if (type === 'notice') {
    toast(value);
  } else if (type === 'device') {
    systemDark = value.dark;
    setColors();
    if (value.startup && preferences.autoConnect && db.selectedId && !state.running) connect();
  }
};

function element(tag, options = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'click') node.addEventListener('click', value);
    else if (key === 'value') node.value = value;
    else if (value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter(child => child != null));
  return node;
}
function button(text, click, className = '') {
  return element('button', {type:'button', text, click, class:className});
}
function option(icon, label, action) {
  return element('button', {class:'option', type:'button', click:action},
    element('span', {text:icon, 'aria-hidden':'true'}), element('span', {text:label}),
    element('span', {text:'›', 'aria-hidden':'true'}));
}
function selectField(entries, value) {
  const select = element('select');
  for (const [key, label] of entries) select.append(element('option', {value:key, text:label}));
  select.value = String(value);
  return select;
}
let fieldId = 0;
function field(label, node) {
  const title = element('span', {id:'field-title-' + (++fieldId), text:label});
  node.setAttribute('aria-labelledby', title.id);
  return element('label', {class:'field'}, title, node);
}
const note = text => element('p', {class:'note', text});

function toast(message) {
  const node = $('toast');
  node.textContent = String(message).slice(0, 250);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2900);
}
function show(title, ...content) {
  clearTimeout(closingTimer);
  const sheet = $('sheet');
  delete sheet.dataset.leaving;
  $('sheet-title').textContent = title;
  sheet.setAttribute('aria-label', title);
  const body = $('sheet-body');
  body.replaceChildren(...content);
  delete body.dataset.enter;
  requestAnimationFrame(() => { body.dataset.enter = 'true'; });
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
function close() {
  detailsOpened = false;
  const sheet = $('sheet');
  if (!sheet.open) return;
  sheet.dataset.leaving = 'true';
  clearTimeout(closingTimer);
  closingTimer = setTimeout(() => { sheet.close(); delete sheet.dataset.leaving; }, 140);
}
window.rayBack = () => {
  if ($('sheet').open) { close(); return true; }
  if (selection.size) { selection.clear(); renderRows(); return true; }
  if (!$('search-wrap').hidden) { toggleSearch(false); return true; }
  return false;
};
$('sheet-close').addEventListener('click', close);
$('sheet').addEventListener('cancel', event => { event.preventDefault(); close(); });
$('sheet').addEventListener('click', event => {
  if (event.target !== $('sheet')) return;
  const rect = $('sheet').getBoundingClientRect();
  if (event.clientY < rect.top || event.clientX < rect.left || event.clientX > rect.right) close();
});
function formError(text = '') { return element('p', {class:'form-error', role:'alert', text}); }
function fixText(value) { return String(value ?? '').replace(/^\uFEFF/, '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim(); }
function safeError(error) {
  const msg = String(error?.message ?? error);
  return /(?:\/\/|PrivateKey|Password)/i.test(msg) ? 'The configuration could not be used' : msg.slice(0, 170);
}
function change(action) {
  try { action(); sync(); return true; }
  catch (error) { toast(safeError(error)); return false; }
}
function persistPrefs() {
  try { modelStorage.setItem('prefs', JSON.stringify(preferences)); }
  catch { toast('Could not save settings.'); }
}
function sync() {
  db = repo.snapshot();
  records = repo.rows();
  selection = new Set([...selection].filter(id => records.some(row => row.id === id)));
  renderRows();
  renderConnection();
  updatePlan();
}
function rowById(id) { return records.find(item => item.id === id); }
function profile(server) {
  if (!server) return null;
  try { return {id:server.id, name:displayServerName(server), outbound:outboundFromShareLink(server.uri)}; }
  catch { return null; }
}
function makePlan(server = rowById(db.selectedId)) {
  const main = profile(server);
  if (!main) return null;
  const candidates = [];
  for (const row of records) {
    if (candidates.length === 6) break;
    if (row.id === main.id) continue;
    const sourceMatches = preferences.switchSource === 'favorites' ? row.favorite : row.subscriptionId === preferences.switchSource;
    if (sourceMatches) {
      const converted = profile(row);
      if (converted) candidates.push(converted);
    }
  }
  return {profile:main, candidates, routing:preferences.routing, switching:preferences.switching};
}
function updatePlan() {
  if (!native) return;
  const plan = makePlan();
  try { modelStorage.setItem('launch', plan ? JSON.stringify(plan) : ''); } catch {}
  if (plan) fire('policy', plan);
}
function getRows(forPing = false) {
  const shown = records.filter(row => (!source || row.subscriptionId === source)
    && (filter === 'all' || (filter === 'pinned' ? row.pinned : row.favorite)));
  const scores = measuring.size ? stableScores : pings;
  const data = filterServers(shown, query).map(row => {
    const result = scores.get(row.id);
    return {...row, latency:result?.average ?? null};
  });
  const result = sortServers(data, preferences.sort, preferences.direction);
  return forPing ? result : result.slice(0, limit);
}
const countryFlag = row => {
  const code = countryOf(row);
  return code ? String.fromCodePoint(...[...code].map(letter => 0x1f1e6 + letter.charCodeAt(0) - 97)) : '◉';
};
function renderRows() {
  const list = $('server-list');
  const fragment = document.createDocumentFragment();
  const shown = getRows();
  for (const row of shown) fragment.append(makeRow(row));
  if (getRows(true).length > shown.length) {
    fragment.append(button('Show more servers', () => { limit += 120; renderRows(); }, 'text-button'));
  }
  list.replaceChildren(fragment);
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (!empty.hidden) {
    empty.querySelector('strong').textContent = repo.loadError ? 'Saved configs could not be opened'
      : records.length ? 'No matching servers' : 'Add your first server';
    empty.querySelector('p').textContent = repo.loadError || (records.length
      ? 'Try another filter or search.' : 'Import a config or subscription to connect.');
    $('empty-add').hidden = !!records.length || !!repo.loadError;
  }
  $('source-picker').hidden = !db.subscriptions.length;
  $('source-picker').textContent = db.subscriptions.find(sub => sub.id === source)?.name || 'Subscriptions';
  $('source-picker').setAttribute('aria-pressed', String(!!source));
  $('selection-actions').hidden = !selection.size;
  $('top-actions').hidden = !!selection.size;
  $('ping-all').textContent = measuring.size ? 'Cancel ping' : '↻  Ping all';
  $('ping-all').disabled = !shown.length && !measuring.size;
}
function toggleSelection(id) {
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  renderRows();
}
function makeRow(row) {
  const label = displayServerName(row);
  const main = button('', () => {
    if (selection.size) toggleSelection(row.id);
    else if (change(() => repo.setSelected(row.id)) && state.running && row.id !== state.profileId) serverMenu(rowById(row.id));
  }, 'row-target');
  let press, x, y;
  main.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    x = event.clientX; y = event.clientY;
    press = setTimeout(() => toggleSelection(row.id), 430);
  });
  main.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - x, event.clientY - y) > 10) clearTimeout(press);
  });
  for (const event of ['pointerup','pointercancel','pointerleave']) main.addEventListener(event, () => clearTimeout(press));
  main.addEventListener('contextmenu', event => { event.preventDefault(); clearTimeout(press); });
  const indicators = [row.favorite ? '★' : '', row.pinned ? '↑' : '', row.id === state.profileId && state.running ? '✓' : ''].filter(Boolean).join(' ');
  const name = element('strong', {class:'server-name', dir:'auto', text:label, title:label});
  if (indicators) name.append(element('span', {class:'server-indicators', text:indicators}));
  const meta = [row.type, row.source !== '—' ? row.source : null].filter(Boolean).join(' · ');
  const info = element('span', {class:'server-info'}, name, element('small', {class:'server-meta', text:meta}));
  const data = pings.get(row.id);
  const latency = data?.average;
  const scoreClass = latency <= 200 ? 'good' : latency <= 400 ? 'fair' : latency <= 800 ? 'slow' : 'bad';
  const scoreText = latency != null ? latency + ' ms' : measuring.has(row.id) ? 'Testing…' : data ? 'No reply' : '—';
  const score = element('span', {class:'ping-cell'},
    element('strong', {class:latency == null ? '' : scoreClass, text:scoreText}),
    data?.attempted > 1 ? element('small', {text:data.count + '/' + data.attempted}) : null);
  main.append(element('span', {class:'flag', 'aria-hidden':'true', text:countryFlag(row)}), info, score);
  const dots = button('⋮', () => serverMenu(row), 'icon dots');
  dots.setAttribute('aria-label', 'Options for ' + label);
  const selected = selection.size ? selection.has(row.id) : row.id === db.selectedId;
  return element('div', {class:'server-row', role:'listitem', 'data-selected':String(selected)}, main, dots);
}

function bytes(value, speed = false) {
  let n = Number(value) || 0;
  const units = ['B','KB','MB','GB','TB'];
  let index = 0;
  while (n >= 1024 && index < units.length - 1) { n /= 1024; index++; }
  return (index ? n.toFixed(n >= 10 ? 0 : 1) : Math.round(n)) + ' ' + units[index] + (speed ? '/s' : '');
}
const phases = {disconnected:'Disconnected',connecting:'Connecting…',connected:'Connected',reconnecting:'Reconnecting…',
  waiting:'Waiting for internet',problem:'Server unavailable',failed:'Could not start VPN',stopping:'Disconnecting…'};
function renderConnection() {
  const active = state.running;
  const label = $('status');
  if (label.dataset.phase !== state.phase) {
    label.dataset.phase = state.phase;
    label.querySelector('span').textContent = phases[state.phase] || 'Disconnected';
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      label.querySelector('span').animate([{opacity:.40},{opacity:1}], {duration:150});
  }
  const selected = rowById(db.selectedId);
  $('connection-name').textContent = (active && state.name) || (selected && displayServerName(selected)) || 'No server selected';
  $('connect').textContent = active ? 'Disconnect' : 'Connect';
  $('connect').disabled = state.phase === 'stopping' || (!active && (!selected || pendingUntil > Date.now()));
  $('connection-data').hidden = $('connection-footer').hidden = !active;
  $('live-latency').textContent = state.live >= 0 ? state.live + ' ms live' : 'Latency —';
  $('transfer').textContent = bytes((state.up ?? 0) + (state.down ?? 0)) + ' used';
  $('rates').textContent = '↓ ' + bytes(state.rateDown, true) + '  ↑ ' + bytes(state.rateUp, true);
  const suggestion = $('suggestion');
  const showSuggestion = !!(state.suggestion || state.undo);
  suggestion.hidden = !showSuggestion;
  if (showSuggestion) {
    suggestion.querySelector('span').textContent = state.suggestion ? 'Try ' + state.suggestion.name : 'Switched server';
    suggestion.querySelector('button').textContent = state.suggestion ? 'Switch' : 'Undo';
    suggestion.querySelector('button').onclick = () => fire(state.suggestion ? 'switch' : 'undo');
  }
  if (detailsOpened && $('detail-current')) $('detail-current').textContent = phases[state.phase] || 'Disconnected';
}
function poll() {
  if (!native) return;
  try {
    const current = JSON.parse(native.connection());
    const changed = current.profileId !== state.profileId || current.running !== state.running;
    const wasConnected = state.phase === 'connected';
    const switched = state.profileId !== current.profileId;
    state = current;
    if (state.running) pendingUntil = 0;
    if (state.phase === 'connected' && (!wasConnected || switched) && state.profileId !== db.selectedId && rowById(state.profileId)) {
      change(() => repo.setSelected(state.profileId));
    } else {
      renderConnection();
      if (changed) renderRows();
    }
  } catch {}
}
function connect(server = rowById(db.selectedId)) {
  const plan = makePlan(server);
  if (!plan) { toast('This configuration is incomplete or has an unsupported option.'); return; }
  if (!native) { toast('Open SimpleRAY on Android to connect.'); return; }
  if (pendingUntil > Date.now()) return;
  pendingUntil = Date.now() + 1800;
  renderConnection();
  fire('connect', plan);
}

function setColors() {
  paintAppearance(document.documentElement, preferences, !systemDark);
  if (native && colorContext) {
    colorContext.fillStyle = getComputedStyle(document.body).backgroundColor;
    colorContext.fillRect(0, 0, 1, 1);
    const rgb = colorContext.getImageData(0, 0, 1, 1).data.slice(0, 3);
    const color = '#' + Array.from(rgb, value => value.toString(16).padStart(2, '0')).join('');
    fire('bars', {dark:document.documentElement.dataset.theme === 'dark', color});
  }
}
systemTheme.addEventListener('change', event => { systemDark = event.matches; setColors(); });
function toggleSearch(force = $('search-wrap').hidden) {
  $('search-wrap').hidden = !force;
  if (force) $('search').focus();
  else {
    $('search').value = query = '';
    renderRows();
  }
}

function addMenu() {
  detailsOpened = false;
  show('Add to SimpleRAY',
    option('▤', 'Paste link', async () => {
      const initial = await request('clipboard').catch(() => '');
      if (initial) importPayload(initial, false);
      else manualForm(null, '');
    }),
    option('⌗', 'Scan QR code', () => { close(); fire('scan'); }),
    option('▱', 'Import file', () => { close(); fire('file'); }),
    option('＋', 'Add manually', () => manualForm()),
    option('⌁', 'Add subscription', () => subscriptionForm()));
}
function importPayload(value, fromOutside) {
  const clean = fixText(value);
  let input = clean;
  let parsed;
  try {
    parsed = parseImport(input);
    if (!parsed.servers.length && !parsed.subscriptionUrls.length) {
      // Apps sometimes share a title on the same line as the link.
      const inline = [...clean.matchAll(/(?:https?(?:-proxy)?|wireguard|wg|hysteria2|hy2|socks5h?|socks|vless|vmess|trojan|ss):\/\/[^\s<>]+/gi)]
        .map(match => match[0]);
      if (inline.length) {
        input = inline.join('\n');
        parsed = parseImport(input);
      }
    }
  } catch (error) {
    manualForm(null, '', safeError(error));
    return;
  }
  let failure = '';
  const usable = parsed.servers.filter(server => {
    try { outboundFromShareLink(server.uri); return true; }
    catch (error) { failure = safeError(error); return false; }
  });
  const errors = parsed.errors.length + parsed.servers.length - usable.length;
  if (usable.length) {
    const before = db.servers.length;
    if (change(() => repo.importManual(usable.map(server => server.uri).join('\n')))) {
      const added = db.servers.length - before;
      toast((added ? 'Added ' + added + (added === 1 ? ' server' : ' servers') : 'Servers already saved')
        + (errors ? ' · ' + errors + ' skipped' : ''));
    }
  }
  if (parsed.subscriptionUrls.length) {
    shareQueue = parsed.subscriptionUrls.slice(1);
    subscriptionForm(null, parsed.subscriptionUrls[0]);
  } else if (usable.length) {
    close();
    if (filter !== 'all' || source || query) {
      setFilter('all'); source = ''; toggleSearch(false);
    }
  } else {
    const message = failure || (parsed.errors[0] && safeError(parsed.errors[0].reason)) || 'Enter a server config or subscription link.';
    manualForm(null, clean.length < 24_000 ? clean : '', (fromOutside ? 'Could not import. ' : '') + message);
  }
}
function manualForm(server = null, initial = '', message = '') {
  detailsOpened = false;
  const uri = element('textarea', {value:server?.uri ?? initial, autocomplete:'off', spellcheck:'false',
    placeholder:'Paste a config or subscription link', 'aria-label':'Config or subscription link'});
  const name = element('input', {value:server?.name ?? '', maxlength:'160', autocomplete:'off', placeholder:'From the config if blank'});
  const error = formError(message);
  const form = element('form', {class:'form'},
    field('Configuration', uri), field('Server name (optional)', name), error,
    element('div', {class:'form-actions'}, button('Cancel', close),
      element('button', {class:'primary', type:'submit', text:server ? 'Save changes' : 'Continue'})));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = fixText(uri.value);
    try {
      if (!server && !name.value.trim()) { importPayload(text, false); return; }
      outboundFromShareLink(text);
      if (server) {
        if (state.running && state.profileId === server.id)
          throw new Error('Disconnect before editing the active configuration');
        repo.updateManual(server.id, text, name.value);
        pings.delete(server.id);
      } else repo.addManual({uri:text, name:name.value});
      sync();
      close();
      toast('Configuration saved');
    } catch (failure) { error.textContent = safeError(failure); }
  });
  show(server ? 'Edit configuration' : 'Add server', form);
}
function subscriptionForm(saved = null, link = '') {
  detailsOpened = false;
  let fallback = '';
  try { fallback = new URL(link).hostname; } catch {}
  const name = element('input', {value:saved?.name ?? fallback, maxlength:'160', required:'', autocomplete:'off'});
  const url = element('input', {type:'url', value:saved?.url ?? link, required:'', autocomplete:'off', spellcheck:'false'});
  const interval = selectField([[0,'Off'],[6,'Every 6 hours'],[24,'Every 24 hours']], saved?.autoRefreshHours ?? 0);
  const error = formError();
  const submit = element('button', {class:'primary', type:'submit', text:'Save & update'});
  const form = element('form', {class:'form'},
    field('Subscription name', name), field('Subscription URL', url), field('Auto-update', interval), error,
    element('div', {class:'form-actions'}, button('Cancel', close), submit));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const clean = validateSubscriptionUrl(fixText(url.value));
      let next;
      if (saved) {
        next = repo.editSubscription(saved.id, {name:name.value, url:clean, autoRefreshHours:Number(interval.value)}).subscription;
      } else {
        const match = db.subscriptions.find(item => item.url === clean);
        next = match || repo.addSubscription(name.value, clean, Number(interval.value));
      }
      sync();
      await refresh(next, {silent:true});
      toast('Subscription updated');
      if (shareQueue.length) subscriptionForm(null, shareQueue.shift());
      else if (saved) subscriptions();
      else close();
    } catch (failure) { error.textContent = safeError(failure) + ' · You can retry from Subscriptions.'; }
    finally { submit.disabled = false; }
  });
  show(saved ? 'Edit subscription' : 'Add subscription', form);
}
async function refresh(sub, {silent = false, restore = false} = {}) {
  if (refreshing.has(sub.id)) return;
  refreshing.add(sub.id);
  try {
    const content = await request('fetch', {url:sub.url});
    const current = repo.snapshot().subscriptions.find(item => item.id === sub.id);
    if (!current || current.url !== sub.url) return;
    const outcome = repo.refreshSubscription(sub.id, fixText(content), new Date().toISOString(), {restoreDeleted:restore});
    sync();
    if (!silent) toast(restore ? 'Restored ' + outcome.restored + ' servers' :
      'Updated · ' + outcome.added + ' added' + (outcome.invalid ? ' · ' + outcome.invalid + ' skipped' : ''));
    return outcome;
  } catch (error) {
    const current = repo.snapshot().subscriptions.find(item => item.id === sub.id);
    if (current?.url === sub.url) {
      change(() => repo.setSubscriptionError(sub.id, 'Update failed. Saved servers are still available.'));
    }
    if (!silent) toast('Update failed. Saved servers are still available.');
    else throw error;
  } finally { refreshing.delete(sub.id); }
}
async function scheduledRefresh() {
  if (document.visibilityState !== 'visible') return;
  if (preferences.wifiRefresh && native && !JSON.parse(native.connection()).wifi) return;
  for (const sub of repo.dueSubscriptions()) {
    await refresh(sub, {silent:true}).catch(() => {});
  }
}
function deleteSubscription(sub) {
  const remove = keepNodes => {
    if (!keepNodes && state.running && rowById(state.profileId)?.subscriptionId === sub.id) {
      toast('Disconnect the active server before removing it.');
      return;
    }
    if (change(() => repo.deleteSubscription(sub.id, {keepNodes}))) {
      if (source === sub.id) source = '';
      renderRows();
      subscriptions();
      toast(keepNodes ? 'Subscription removed. Servers kept.' : 'Subscription removed');
    }
  };
  show('Remove subscription?', note(sub.name),
    option('✓', 'Remove subscription and keep servers', () => remove(true)),
    option('×', 'Remove subscription and delete its servers', () => remove(false)),
    button('Cancel', subscriptions));
}
function subscriptions() {
  detailsOpened = false;
  const list = element('div');
  for (const sub of db.subscriptions) {
    const count = records.filter(row => row.subscriptionId === sub.id).length;
    const updated = sub.updatedAt ? ' · Updated ' + new Date(sub.updatedAt).toLocaleString() : '';
    const action = button('Update', async () => {
      action.disabled = true; action.textContent = 'Updating…';
      await refresh(sub);
      if ($('sheet-title').textContent === 'Subscriptions' && $('sheet').open) subscriptions();
    }, 'text-button');
    const controls = element('div', {class:'inline'}, action,
      button('Edit', () => subscriptionForm(sub), 'text-button'),
      button('Remove', () => deleteSubscription(sub), 'text-button'));
    if (sub.hiddenSignatures.length) controls.append(button('Restore hidden', async () => {
      await refresh(sub, {restore:true});
      if ($('sheet').open && $('sheet-title').textContent === 'Subscriptions') subscriptions();
    }, 'text-button'));
    list.append(element('div', {class:'list-entry'},
      element('strong', {text:sub.name, dir:'auto'}), note(count + ' servers' + updated),
      sub.lastError ? formError(sub.lastError) : null, controls));
  }
  show('Subscriptions', option('＋', 'Add subscription', () => subscriptionForm()),
    db.subscriptions.length ? list : note('Your subscriptions will appear here.'));
}
function rename(server) {
  const name = element('input', {value:server.name, maxlength:'160', required:'', dir:'auto'});
  const error = formError();
  const form = element('form', {class:'form'}, field('Name', name), error,
    element('div', {class:'form-actions'}, button('Cancel', close), element('button', {type:'submit', class:'primary', text:'Save'})));
  form.addEventListener('submit', event => {
    event.preventDefault();
    try { repo.renameServer(server.id, name.value); sync(); close(); }
    catch (failure) { error.textContent = safeError(failure); }
  });
  show('Rename server', form);
}
function confirmRemove(ids) {
  if (state.running && ids.includes(state.profileId)) {
    toast('Disconnect before removing the active server.');
    return;
  }
  const containsSub = ids.some(id => rowById(id)?.subscriptionId);
  show(ids.length === 1 ? 'Remove server?' : 'Remove ' + ids.length + ' servers?',
    note(containsSub ? 'Servers from subscriptions are hidden. Manually added servers are deleted.' :
      'The selected configuration will be removed.'),
    element('div', {class:'form-actions'}, button('Cancel', close), button('Remove', () => {
      if (change(() => repo.deleteServers(ids))) { ids.forEach(id => pings.delete(id)); close(); renderRows(); }
    }, 'danger')));
}
function serverMenu(server) {
  if (!server) return;
  detailsOpened = false;
  const active = state.running && state.profileId === server.id;
  const menu = [];
  if (!active) menu.push(option('↗', state.running ? 'Connect to this server' : 'Connect', () => {
    if (!change(() => repo.setSelected(server.id))) return;
    close(); connect(server);
  }));
  menu.push(
    option('↻', 'Ping server', () => { close(); ping([server]); }),
    option(server.favorite ? '★' : '☆', server.favorite ? 'Remove from favorites' : 'Add to favorites',
      () => { if (change(() => repo.toggleFavorite(server.id))) close(); }),
    option('↑', server.pinned ? 'Unpin' : 'Pin to top', () => { if (change(() => repo.togglePin(server.id))) close(); }),
    option('✎', 'Rename', () => rename(server)),
  );
  if (!server.subscriptionId) menu.push(option('▤', 'Edit configuration', () => manualForm(server)));
  else menu.push(option('＋', 'Duplicate as editable config', () => {
    if (change(() => repo.duplicateManual(server.id))) close();
  }));
  menu.push(
    option('⧉', 'Copy config', () => { fire('copy', {text:server.uri, sensitive:true}); close(); toast('Config copied'); }),
    option('↗', 'Share config', () => { close(); fire('share', {text:server.uri}); }),
    option('○', 'Exit IP history', () => history(server.id)),
    option('×', server.subscriptionId ? 'Hide server' : 'Delete server', () => confirmRemove([server.id])),
  );
  show(displayServerName(server), ...menu);
}
function setFilter(value) {
  filter = value; limit = 120;
  for (const control of document.querySelectorAll('[data-filter]'))
    control.setAttribute('aria-pressed', String(control.dataset.filter === filter));
  renderRows();
}
function chooseSource() {
  const options = [option('≡', 'All sources', () => { source = ''; limit = 120; close(); renderRows(); })];
  for (const sub of db.subscriptions) options.push(option('⌁', sub.name, () => {
    source = sub.id; limit = 120; close(); renderRows();
  }));
  show('Subscription filter', ...options);
}
function listOptions() {
  const keys = [['','Saved order'],['favorite','Favorites'],['name','Name'],['type','Protocol'],['latency','Latency'],['source','Source']];
  const sort = selectField(keys, preferences.sort ?? '');
  const direction = selectField([['asc','Ascending'],['desc','Descending']], preferences.direction);
  function apply() {
    preferences.sort = sort.value || null;
    preferences.direction = direction.value;
    persistPrefs(); renderRows();
  }
  sort.addEventListener('change', apply);
  direction.addEventListener('change', apply);
  show('Server list', element('div', {class:'form'}, field('Sort by', sort), field('Order', direction)),
    option('⌁', 'Manage subscriptions', subscriptions));
}

async function ping(rows) {
  if (!rows.length || measuring.size) return;
  const targets = rows.map(profile).filter(Boolean);
  if (!targets.length) { toast('There are no testable configurations here.'); return; }
  stableScores = new Map(pings);
  measuring = new Set(targets.map(item => item.id));
  const results = new Map(targets.map(item => [item.id, []]));
  const token = ++lastPingToken;
  for (const id of measuring) pings.delete(id);
  renderRows();
  try {
    for (let round = 0; round < preferences.pings; round++) {
      const responded = [...results.values()].some(list => list.some(delay => delay >= 0));
      const timeout = round > 0 && round === preferences.pings - 1 && !responded ? 10 : 5;
      for (let offset = 0; offset < targets.length; offset += 4) {
        if (token !== lastPingToken) return;
        const batch = targets.slice(offset, offset + 4);
        const tested = await request('ping', {profiles:batch, timeout});
        if (token !== lastPingToken) return;
        batch.forEach((item, index) => {
          const values = results.get(item.id);
          const sample = tested?.[index];
          values.push(sample?.success && Number(sample.delay) >= 0 ? Number(sample.delay) : -1);
          const good = values.filter(delay => delay >= 0);
          pings.set(item.id, {average:good.length ? Math.round(good.reduce((a,b) => a+b, 0) / good.length) : null,
            count:good.length, attempted:values.length});
        });
        renderRows();
      }
    }
  } catch (error) { if (token === lastPingToken) toast(safeError(error)); }
  finally {
    if (token === lastPingToken) { measuring = new Set(); renderRows(); }
  }
}
function cancelPing() {
  ++lastPingToken;
  measuring = new Set();
  renderRows();
  toast('Ping cancelled');
}
function selectedValue(callback) {
  return event => { callback(event.target.value); persistPrefs(); };
}
function group(title, ...children) {
  return element('section', {class:'settings-group'}, element('h3', {text:title}), ...children);
}
function switchLine(text, checked, onChange) {
  const input = element('input', {type:'checkbox'});
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return element('label', {class:'switchline'}, element('span', {text}), input);
}
function settings() {
  detailsOpened = false;
  const paletteNames = {ocean:'Ocean',jade:'Jade',violet:'Violet',custom:'Custom'};
  const palette = element('div', {class:'theme-grid'});
  const contrast = element('div', {class:'segments'});
  const canvas = element('canvas', {width:'196', height:'196', 'aria-label':'Color wheel'});
  const target = selectField([['themePrimary','Primary'],['themeAccent','Accent']], 'themePrimary');
  const brightness = element('input', {type:'range', min:'0', max:'100', 'aria-label':'Brightness'});
  const hex = element('input', {type:'text', maxlength:'7', autocomplete:'off', spellcheck:'false', 'aria-label':'Hex color'});
  const preview = element('span', {class:'wheel-preview', 'aria-hidden':'true'});
  const wheel = element('div', {class:'wheel'}, canvas, element('div', {class:'wheel-fields'},
    field('Color', target), field('Brightness', brightness), field('HEX', hex), preview));
  wheel.hidden = preferences.palette !== 'custom';
  const selector = attachColorWheel({canvas,target,brightness,hex,preview,read:key => preferences[key],
    write:(key,value) => { preferences[key] = value; setColors(); selector.refresh(); }, commit:persistPrefs});
  for (const key of THEME_PALETTES) {
    const control = element('button', {type:'button', 'data-theme-palette':key,
      'aria-pressed':String(preferences.palette === key), click:() => {
        preferences.palette = key; persistPrefs(); setColors();
        for (const item of palette.children) item.setAttribute('aria-pressed', String(item.dataset.themePalette === key));
        wheel.hidden = key !== 'custom';
        if (!wheel.hidden) selector.refresh();
      }}, element('span', {class:'swatch ' + key}), document.createTextNode(paletteNames[key]));
    palette.append(control);
  }
  for (const key of APPEARANCE_MODES) {
    const control = element('button', {type:'button', text:key[0].toUpperCase()+key.slice(1),
      'data-mode':key, 'aria-pressed':String(preferences.appearance === key), click:() => {
        preferences.appearance = key; persistPrefs(); setColors();
        for (const item of contrast.children) item.setAttribute('aria-pressed', String(item.dataset.mode === key));
      }});
    contrast.append(control);
  }
  const mode = selectField([['off','Off'],['suggest','Suggest'],['automatic','Automatic']], preferences.switching);
  const candidate = selectField([['favorites','Favorites'],...db.subscriptions.map(sub => [sub.id,sub.name])], preferences.switchSource);
  if (!candidate.value) candidate.value = 'favorites';
  const samples = selectField([[1,'1 · Single'],[2,'2 · Balanced'],[3,'3 · Average']], preferences.pings);
  mode.addEventListener('change', selectedValue(value => { preferences.switching = value; updatePlan(); }));
  candidate.addEventListener('change', selectedValue(value => { preferences.switchSource = value; updatePlan(); }));
  samples.addEventListener('change', selectedValue(value => { preferences.pings = Number(value); }));
  show('Settings',
    group('Theme', palette, wheel),
    group('Appearance', contrast),
    group('Latency and switching', element('div', {class:'form'}, field('Pings per server', samples),
      field('Server switching', mode), field('Candidate source · up to six servers', candidate))),
    group('Android connection',
      switchLine('Auto-connect when opening the app', preferences.autoConnect, value => { preferences.autoConnect=value; persistPrefs(); }),
      option('▦', 'Add Quick Settings tile', () => fire('tile')),
      option('⏻', 'Always-on VPN and block outside tunnel', () => fire('vpnSettings')),
      option('↳', 'Routing rules', routing)),
    group('Subscriptions', switchLine('Auto-update on Wi-Fi only', preferences.wifiRefresh,
      value => { preferences.wifiRefresh=value; persistPrefs(); }), option('⌁', 'Manage subscriptions', subscriptions)),
    group('Support', option('▤', 'Error report', diagnostics), note('SimpleRAY Android 0.2.0-beta.1')),
  );
  if (!wheel.hidden) selector.refresh();
}
function normalizeDomain(value) {
  const text = String(value).trim().toLowerCase().replace(/^\.+/, '');
  const parsed = new URL(text.includes('://') ? text : 'https://' + text);
  const host = parsed.hostname.replace(/\.$/, '');
  if (!host || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error('Enter a website or domain suffix');
  return host;
}
async function routing() {
  detailsOpened = false;
  const current = JSON.parse(JSON.stringify(preferences.routing));
  const mode = selectField([['all','All apps'],['only','Only selected apps'],['except','All except selected apps']], current.appMode);
  const appList = element('div', {class:'app-picker'}, note('Loading installed apps…'));
  const search = element('input', {type:'search', placeholder:'Search installed apps', 'aria-label':'Search installed apps'});
  const appPanel = element('div', {}, search, appList);
  appPanel.hidden = mode.value === 'all';
  const checked = new Set(current.apps);
  const rules = element('div');
  const domainInput = element('input', {type:'text', placeholder:'example.com or .ir', 'aria-label':'Website or domain suffix'});
  const domainMode = selectField([['direct','Direct'],['proxy','Tunnel']], 'direct');
  const error = formError();
  const redrawRules = () => {
    rules.replaceChildren(...current.domains.map((rule, index) =>
      element('div', {class:'rule'}, element('span', {text:rule.host}), element('strong', {text:rule.mode === 'direct' ? 'Direct' : 'Tunnel'}),
        button('×', () => { current.domains.splice(index, 1); redrawRules(); }, 'icon'))));
  };
  const append = () => {
    try {
      const host = normalizeDomain(domainInput.value);
      current.domains = current.domains.filter(item => item.host !== host);
      current.domains.push({host,mode:domainMode.value,suffix:true});
      current.domains.sort((a,b) => b.host.length - a.host.length);
      domainInput.value = '';
      error.textContent = '';
      redrawRules();
    } catch (failure) { error.textContent = safeError(failure); }
  };
  const verify = element('input', {type:'text', placeholder:'example.com', 'aria-label':'Website to check'});
  const preview = note('');
  const test = () => {
    try {
      const host = normalizeDomain(verify.value);
      const result = current.domains.find(rule => host === rule.host || host.endsWith('.' + rule.host));
      preview.textContent = host + ' → ' + (result?.mode === 'direct' ? 'Direct' : 'Tunnel') +
        (result ? ' · matched ' + result.host : ' · default');
    } catch { preview.textContent = 'Enter a valid website address'; }
  };
  mode.addEventListener('change', () => { appPanel.hidden = mode.value === 'all'; });
  show('Routing rules', group('Apps', field('Which apps use the VPN', mode), appPanel,
    note('Apps outside the VPN use their usual network. Website rules apply to apps inside the VPN.')),
    group('Websites', element('div', {class:'rule'}, domainInput, domainMode, button('Add', append)), rules,
      element('div', {class:'inline'}, verify, button('Check route', test)), preview),
    error, element('div', {class:'form-actions'}, button('Cancel', settings), button('Save routing', () => {
      if (mode.value === 'only' && !checked.size) { error.textContent = 'Select at least one app.'; return; }
      preferences.routing = {...current,appMode:mode.value,apps:[...checked]};
      persistPrefs(); updatePlan();
      const active = rowById(state.profileId);
      if (state.running && active) connect(active);
      settings();
      toast('Routing saved');
    }, 'primary')));
  redrawRules();
  try {
    const apps = await request('apps');
    function listApps() {
      const term = search.value.trim().toLowerCase();
      const list = apps.filter(app => (app.label + ' ' + app.id).toLowerCase().includes(term));
      appList.replaceChildren(...list.map(app => switchLine(app.label, checked.has(app.id), on => {
        if (on) checked.add(app.id); else checked.delete(app.id);
      })));
      if (!list.length) appList.append(note('No matching apps'));
    }
    search.addEventListener('input', listApps);
    listApps();
  } catch { appList.replaceChildren(note('Could not read the app list.')); }
}
function history(id) {
  detailsOpened = false;
  let rows = [];
  try { rows = JSON.parse(modelStorage.getItem('history') || '[]'); } catch {}
  if (id) rows = rows.filter(row => row.id === id);
  show('Exit IP history', rows.length ? element('div', {}, ...rows.map(row =>
    element('div', {class:'list-entry'}, element('strong', {text:row.ip}), note(new Date(row.time).toLocaleString()))))
    : note('An exit IP is recorded after a successful connection when the lookup responds.'));
}
function details() {
  detailsOpened = true;
  const rate = value => value ? bytes(value, true) : '—';
  const row = element('div', {class:'list-entry'}, element('strong', {text:'Connection status'}),
    element('p', {class:'note', id:'detail-current', text:phases[state.phase]}));
  const progress = note(downloadResult || 'Downloads up to 3 MB through the active VPN.');
  const test = button('↓ Test download', async () => {
    test.disabled = true;
    progress.textContent = 'Measuring…';
    try {
      const measured = await request('download');
      downloadResult = bytes(measured.bytes, false) + ' · ' + rate(measured.bytes * 1000 / measured.ms);
      progress.textContent = downloadResult;
    } catch (failure) { progress.textContent = safeError(failure); }
    finally { test.disabled = false; }
  }, 'text-button');
  show('Connection details', row,
    group('Traffic this session', note('Downloaded ' + bytes(state.down) + ' · Uploaded ' + bytes(state.up)),
      test, progress),
    option('↻', 'Refresh live latency', () => { fire('live'); toast('Checking the active server…'); }),
    option('○', 'Exit IP history', () => history(state.profileId || db.selectedId)),
    option('▤', 'Copy diagnostics', diagnostics));
}
function diagnostics() {
  detailsOpened = false;
  const platform = 'Android VPN';
  const message = [
    'SimpleRAY 0.2.0-beta.1', platform,
    'Status: ' + (phases[state.phase] || 'Unknown'),
    'Profile type: ' + (rowById(state.profileId || db.selectedId)?.type || 'None'),
    'VPN mode: ' + preferences.routing.appMode,
    'Live samples: ' + (state.wins ?? 0) + '/' + (state.samples ?? 0),
    'Saved servers: ' + records.length,
    'Subscriptions with update errors: ' + db.subscriptions.filter(sub => sub.lastError).length,
  ].join('\n');
  show('Error report', element('textarea', {readonly:'', value:message, 'aria-label':'Error report'}),
    button('Copy report', () => {
      if (native) fire('copy', {text:message});
      else navigator.clipboard?.writeText(message).catch(() => {});
      toast('Report copied');
    }, 'primary'));
}

$('add-button').addEventListener('click', addMenu);
$('empty-add').addEventListener('click', addMenu);
$('settings-button').addEventListener('click', settings);
$('search-button').addEventListener('click', () => toggleSearch());
$('search').addEventListener('input', event => { query = event.target.value; limit = 120; renderRows(); });
$('list-options').addEventListener('click', listOptions);
$('source-picker').addEventListener('click', chooseSource);
$('details').addEventListener('click', details);
$('clear-selection').addEventListener('click', () => { selection.clear(); renderRows(); });
$('remove-selection').addEventListener('click', () => confirmRemove([...selection]));
$('ping-selection').addEventListener('click', () => {
  const rows = records.filter(row => selection.has(row.id));
  selection.clear();
  ping(rows);
});
$('ping-all').addEventListener('click', () => measuring.size ? cancelPing() : ping(getRows(true)));
$('connect').addEventListener('click', () => state.running ? fire('disconnect') : connect());
for (const item of document.querySelectorAll('[data-filter]'))
  item.addEventListener('click', () => setFilter(item.dataset.filter));

setColors();
sync();
poll();
if (native) {
  setInterval(poll, 750);
  setInterval(scheduledRefresh, 60_000);
  setTimeout(scheduledRefresh, 7000);
}
