import {createPortableBackup, readPortableBackup} from '../shared/portable-backup.js';
import {createRepository, STORAGE_KEY} from '../shared/store.js';
import {parseImport, validateSubscriptionUrl} from '../shared/config.js';
import {outboundFromShareLink} from '../shared/xray-config.js';
import {filterServers, latencyClass, sortServers} from '../shared/model.js';
import {countryOf, displayServerName} from '../shared/flags.js';
import {restoreAppearance, paintAppearance, THEME_PALETTES, APPEARANCE_MODES} from '../shared/theme.js';
import {attachColorWheel} from '../shared/color-wheel.js';
import {bytesPerSecond, DEFAULT_PING_SAMPLES, formatBytes} from '../shared/runtime.js';

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
    pings: [1,2,3].includes(saved.pings) ? saved.pings : DEFAULT_PING_SAMPLES,
    switching: ['off','suggest','automatic'].includes(saved.switching) ? saved.switching : 'off',
    switchSource: typeof saved.switchSource === 'string' ? saved.switchSource : 'favorites',
    sort: ['favorite','name','type','latency','source'].includes(saved.sort) ? saved.sort : null,
    direction: saved.direction === 'desc' ? 'desc' : 'asc',
    autoConnect: !!saved.autoConnect,
    routing: saved.routing?.domains && saved.routing?.apps ? saved.routing : freshRouting(),
  };
}
const preferences = loadPreferences();
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let colorContext, paintFrame, lastBarColor, lastStatus;
let systemDark = systemTheme.matches;
let db = repo.snapshot();
let records = repo.rows();
let state = {phase:'disconnected'};
let filter = 'all', source = '', query = '', selection = new Set(), limit = 120;
const pings = new Map(), visiblePingCells = new Map();
let stableScores = new Map(), measuring = new Set(), lastPingToken = 0;
let shareQueue = [];
let toastTimer;
const sheet = $('sheet');
const sheetHandle = $('sheet-handle');
let closingTimer, sheetMotion, drag, suppressHandleClick;
let pendingUntil = 0;
let detailsOpened = false;
let downloadResult = null;
const refreshing = new Set();
const replies = new Map();
let replyId = 0;
let stagedPlan;
let profilesRevision = 0;

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
  } else if (type === 'backup') {
    confirmRestore(value);
  } else if (type === 'backupDestination') {
    writeBackup('writeBackup');
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
const svgNamespace = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  const use = document.createElementNS(svgNamespace, 'use');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', '../shared/icons.svg#icon-' + name);
  svg.append(use);
  return svg;
}
function iconButton(name, label, action, className = 'icon') {
  return element('button', {class:className, type:'button', 'aria-label':label, click:action}, icon(name));
}
function option(name, label, action) {
  return element('button', {class:'option', type:'button', click:action},
    icon(name), element('span', {text:label, dir:'auto'}), icon('chevron'));
}
const buttonIcon = (id, name) => $(id).querySelector('use').setAttribute('href', '../shared/icons.svg#icon-' + name);
function updateText(node, text) {
  if (node.textContent !== text) node.textContent = text;
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
  delete sheet.dataset.leaving;
  delete sheet.dataset.dragging;
  drag = null;
  sheet.style.removeProperty('--sheet-drag');
  $('sheet-title').textContent = title;
  sheet.setAttribute('aria-label', title);
  const body = $('sheet-body');
  body.replaceChildren(...content.filter(item => item != null));
  if (!sheet.open) {
    sheet.showModal();
    if (!reducedMotion.matches)
      sheetMotion = sheet.animate([{transform:'translateY(24px)', opacity:.7}, {transform:'none', opacity:1}],
        {duration:180, easing:'cubic-bezier(.15,.75,.30,1)'});
  } else if (!reducedMotion.matches) {
    body.animate([{opacity:.55, transform:'translateY(5px)'}, {opacity:1, transform:'none'}], 150);
  }
  sheet.scrollTop = 0;
}
function close(offset = 0) {
  detailsOpened = false;
  if (!sheet.open || sheet.dataset.leaving) return;
  sheetMotion?.cancel();
  sheet.style.setProperty('--sheet-drag', offset + 'px');
  sheet.dataset.leaving = 'true';
  closingTimer = setTimeout(() => {
    sheet.close();
    delete sheet.dataset.leaving;
    sheet.style.removeProperty('--sheet-drag');
  }, reducedMotion.matches ? 0 : 140);
}
sheetHandle.addEventListener('pointerdown', event => {
  if (event.button !== 0 || drag || sheet.dataset.leaving) return;
  sheetMotion?.cancel();
  suppressHandleClick = false;
  drag = {id:event.pointerId, start:event.clientY, time:event.timeStamp, offset:0,
    threshold:Math.min(85, Math.max(56, sheet.offsetHeight * .22))};
  sheetHandle.setPointerCapture(event.pointerId);
  sheet.dataset.dragging = '';
});
sheetHandle.addEventListener('pointermove', event => {
  if (drag?.id !== event.pointerId) return;
  const delta = event.clientY - drag.start;
  suppressHandleClick ||= Math.abs(delta) > 8;
  drag.offset = Math.max(0, delta);
  sheet.style.setProperty('--sheet-drag', drag.offset + 'px');
});
function finishDrag(event) {
  if (drag?.id !== event.pointerId) return;
  const {offset, threshold, time} = drag;
  const release = event.type === 'pointerup';
  drag = null;
  delete sheet.dataset.dragging;
  sheet.style.removeProperty('--sheet-drag');
  if (release && (offset >= threshold || (offset >= 34 && event.timeStamp - time < 190))) {
    close(offset);
  } else if (offset > 0 && !reducedMotion.matches) {
    sheetMotion = sheet.animate([{transform:'translateY(' + offset + 'px)'}, {transform:'none'}],
      {duration:150, easing:'ease-out'});
  }
}
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) sheetHandle.addEventListener(event, finishDrag);
sheetHandle.addEventListener('click', event => {
  if (event.detail === 0 || !suppressHandleClick) close();
  suppressHandleClick = false;
});
window.rayBack = () => {
  if (sheet.open) { close(); return true; }
  if (selection.size) { selection.clear(); renderRows(); return true; }
  if (!$('search-wrap').hidden) { toggleSearch(false); return true; }
  return false;
};
$('sheet-close').addEventListener('click', () => close());
sheet.addEventListener('cancel', event => { event.preventDefault(); close(); });
sheet.addEventListener('click', event => {
  if (event.target !== sheet) return;
  const rect = sheet.getBoundingClientRect();
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
  const availableIds = new Set(records.map(row => row.id));
  if (source && !db.subscriptions.some(sub => sub.id === source)) source = '';
  if (filter === 'subscriptions' && !db.subscriptions.length) filter = 'all';
  selection = new Set([...selection].filter(id => availableIds.has(id)));
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
  const raw = plan ? JSON.stringify(plan) : '';
  if (stagedPlan === raw) return;
  try {
    modelStorage.setItem('launch', raw);
    stagedPlan = raw;
  } catch {}
  if (plan) fire('policy', plan);
}
function getRows() {
  const shown = records.filter(row => {
    if (filter === 'subscriptions') return row.subscriptionId && (!source || row.subscriptionId === source);
    if (filter === 'pinned') return row.pinned;
    if (filter === 'favorite') return row.favorite;
    return true;
  });
  const matches = filterServers(shown, query);
  if (preferences.sort !== 'latency') return sortServers(matches, preferences.sort, preferences.direction);
  const scores = measuring.size ? stableScores : pings;
  return sortServers(matches.map(row => ({...row, latency:scores.get(row.id)?.average ?? null})),
    preferences.sort, preferences.direction);
}
const countryFlag = row => {
  const code = countryOf(row);
  return code ? String.fromCodePoint(...[...code].map(letter => 0x1f1e6 + letter.charCodeAt(0) - 97)) : icon('globe');
};
function renderRows() {
  const list = $('server-list');
  const fragment = document.createDocumentFragment();
  const matches = getRows();
  const shown = matches.slice(0, limit);
  visiblePingCells.clear();
  for (const row of shown) fragment.append(makeRow(row));
  if (matches.length > limit) {
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
  const picker = $('source-picker');
  const picked = db.subscriptions.find(sub => sub.id === source)?.name;
  updateText(picker.querySelector('span'), picked || 'Subscriptions');
  picker.title = picked || 'Choose a subscription';
  picker.setAttribute('aria-label', picked ? 'Subscriptions: ' + picked : 'Subscriptions');
  picker.setAttribute('aria-pressed', String(filter === 'subscriptions'));
  for (const control of document.querySelectorAll('[data-filter]'))
    control.setAttribute('aria-pressed', String(control.dataset.filter === filter));
  $('selection-actions').hidden = !selection.size;
  $('top-actions').hidden = !!selection.size;
  const ping = $('ping-all');
  updateText(ping.querySelector('span'), measuring.size ? 'Cancel ping' : selection.size ? 'Ping selected' : 'Ping all');
  buttonIcon('ping-all', measuring.size ? 'close' : 'activity');
  ping.disabled = !shown.length && !selection.size && !measuring.size;
}
function toggleSelection(id) {
  if (selection.has(id)) selection.delete(id); else selection.add(id);
  renderRows();
}
function makeRow(row) {
  const label = displayServerName(row);
  let held = false;
  const main = button('', () => {
    if (held) { held = false; return; }
    if (selection.size) toggleSelection(row.id);
    else if ((row.id === db.selectedId || change(() => repo.setSelected(row.id))) && state.running && row.id !== state.profileId)
      serverMenu(rowById(row.id));
  }, 'row-target');
  let press, x, y;
  main.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    held = false;
    x = event.clientX; y = event.clientY;
    press = setTimeout(() => { held = true; toggleSelection(row.id); }, 430);
  });
  main.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - x, event.clientY - y) > 10) clearTimeout(press);
  });
  for (const event of ['pointerup','pointercancel','pointerleave']) main.addEventListener(event, () => clearTimeout(press));
  main.addEventListener('contextmenu', event => { event.preventDefault(); clearTimeout(press); });
  const indicators = [row.favorite && 'star', row.pinned && 'pin', row.id === state.profileId && state.running && 'check']
    .filter(Boolean).map(icon);
  const name = element('strong', {class:'server-name', dir:'auto', text:label, title:label});
  if (indicators.length) name.append(element('span', {class:'server-indicators'}, ...indicators));
  const meta = [row.type, row.source !== '—' ? row.source : null].filter(Boolean).join(' · ');
  const info = element('span', {class:'server-info'}, name, element('small', {class:'server-meta', text:meta}));
  const score = element('span', {class:'ping-cell'}, element('strong'), element('small'));
  visiblePingCells.set(row.id, score);
  renderPingCell(row.id);
  const flag = element('span', {class:'flag', 'aria-hidden':'true'}, countryFlag(row));
  main.append(flag, info, score);
  const dots = iconButton('more', 'Options for ' + label, () => serverMenu(rowById(row.id)), 'icon dots');
  const selected = selection.size ? selection.has(row.id) : row.id === db.selectedId;
  return element('div', {class:'server-row', role:'listitem', 'data-selected':String(selected)}, main, dots);
}

function renderPingCell(id) {
  const cell = visiblePingCells.get(id);
  if (!cell) return;
  const result = pings.get(id);
  const value = result?.average;
  const score = cell.firstElementChild, samples = cell.lastElementChild;
  score.className = value == null ? '' : latencyClass(value);
  updateText(score, value != null ? value + ' ms' : measuring.has(id) && !result ? 'Testing…' : result ? 'No reply' : '—');
  samples.hidden = !(result?.attempted > 1);
  if (!samples.hidden) updateText(samples, result.count + '/' + result.attempted);
}

const phases = {disconnected:'Disconnected',connecting:'Connecting…',connected:'Connected',reconnecting:'Reconnecting…',
  waiting:'Waiting for internet',problem:'Server unavailable',failed:'Could not start VPN',stopping:'Disconnecting…'};
function renderConnection() {
  const active = !!state.running;
  const label = $('status');
  if (label.dataset.phase !== state.phase) {
    label.dataset.phase = state.phase;
    updateText(label.querySelector('span'), phases[state.phase] || 'Disconnected');
    if (!reducedMotion.matches) label.querySelector('span').animate([{opacity:.40},{opacity:1}], {duration:150});
  }
  const selected = rowById(db.selectedId);
  updateText($('connection-name'), (active && state.name) || (selected && displayServerName(selected)) || 'No server selected');
  const action = $('connect');
  updateText(action.querySelector('span'), active ? 'Disconnect' : 'Connect');
  action.setAttribute('aria-pressed', String(active));
  action.disabled = state.phase === 'stopping' || (!active && (!selected || pendingUntil > Date.now()));
  $('connection-data').hidden = $('details').hidden = !active;
  if (active) {
    const latency = $('live-latency');
    const hasLatency = state.live >= 0;
    updateText(latency, hasLatency ? state.live + ' ms' : '— ms');
    latency.parentElement.dataset.grade = hasLatency ? latencyClass(state.live) : '';
    updateText($('transfer'), formatBytes((state.up ?? 0) + (state.down ?? 0)) + ' used');
    updateText($('rate-down'), bytesPerSecond(state.rateDown ?? 0));
    updateText($('rate-up'), bytesPerSecond(state.rateUp ?? 0));
  }
  const suggestion = $('suggestion');
  suggestion.hidden = !(state.suggestion || state.undo);
  if (!suggestion.hidden) {
    updateText(suggestion.querySelector('span'), state.suggestion ? 'Try ' + state.suggestion.name : 'Switched server');
    updateText(suggestion.querySelector('button'), state.suggestion ? 'Switch' : 'Undo');
  }
  if (detailsOpened && $('detail-current')) {
    updateText($('detail-current'), phases[state.phase] || 'Disconnected');
    updateText($('detail-traffic'), sessionTraffic());
  }
}
function poll() {
  if (!native || document.hidden) return;
  try {
    const raw = native.status();
    const pendingExpired = pendingUntil && Date.now() >= pendingUntil;
    if (pendingExpired) pendingUntil = 0;
    if (raw === lastStatus) {
      if (pendingExpired) renderConnection();
      return;
    }
    const current = JSON.parse(raw);
    lastStatus = raw;
    const switched = state.profileId !== current.profileId;
    const changed = switched || current.running !== state.running;
    const wasConnected = state.phase === 'connected';
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
  if (!native || paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    if (!colorContext) {
      const probe = document.createElement('canvas');
      probe.width = probe.height = 1;
      colorContext = probe.getContext('2d', {willReadFrequently:true});
    }
    if (!colorContext) return;
    const background = getComputedStyle(document.body).backgroundColor;
    const dark = document.documentElement.dataset.theme === 'dark';
    const signature = dark + background;
    if (signature === lastBarColor) return;
    lastBarColor = signature;
    colorContext.fillStyle = background;
    colorContext.fillRect(0, 0, 1, 1);
    const rgb = colorContext.getImageData(0, 0, 1, 1).data.slice(0, 3);
    const color = '#' + Array.from(rgb, value => value.toString(16).padStart(2, '0')).join('');
    fire('bars', {dark, color});
  });
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
    option('clipboard', 'Paste link', async () => {
      const initial = await request('clipboard').catch(() => '');
      if (initial) importPayload(initial, false);
      else manualForm(null, '');
    }),
    option('qr', 'Scan QR code', () => { close(); fire('scan'); }),
    option('file', 'Import file', () => { close(); fire('file'); }),
    option('plus', 'Add manually', () => manualForm()),
    option('link', 'Add subscription', () => subscriptionForm()));
}
function importPayload(value, fromOutside) {
  if (/^\s*\{/.test(value) && /"format"\s*:\s*"simpleray\.backup"/.test(value)) {
    confirmRestore(String(value).trim());
    return;
  }
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
    element('div', {class:'form-actions'}, button('Cancel', () => close()),
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
    element('div', {class:'form-actions'}, button('Cancel', () => close()), submit));
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
  const revision = profilesRevision;
  try {
    const content = await request('fetch', {url:sub.url});
    if (revision !== profilesRevision) return;
    const current = db.subscriptions.find(item => item.id === sub.id);
    if (!current || current.url !== sub.url) return;
    const outcome = repo.refreshSubscription(sub.id, fixText(content), new Date().toISOString(), {restoreDeleted:restore});
    sync();
    if (!silent) toast(restore ? 'Restored ' + outcome.restored + ' servers' :
      'Updated · ' + outcome.added + ' added' + (outcome.invalid ? ' · ' + outcome.invalid + ' skipped' : ''));
    return outcome;
  } catch (error) {
    if (revision !== profilesRevision) return;
    const current = db.subscriptions.find(item => item.id === sub.id);
    if (current?.url === sub.url) {
      change(() => repo.setSubscriptionError(sub.id, 'Update failed. Saved servers are still available.'));
    }
    if (!silent) toast('Update failed. Saved servers are still available.');
    else throw error;
  } finally { refreshing.delete(sub.id); }
}
async function scheduledRefresh() {
  if (document.visibilityState !== 'visible') return;
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
      subscriptions();
      toast(keepNodes ? 'Subscription removed. Servers kept.' : 'Subscription removed');
    }
  };
  show('Remove subscription?', note(sub.name),
    option('check', 'Remove subscription and keep servers', () => remove(true)),
    option('delete', 'Remove subscription and delete its servers', () => remove(false)),
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
  show('Subscriptions', option('plus', 'Add subscription', () => subscriptionForm()),
    db.subscriptions.length ? list : note('Your subscriptions will appear here.'));
}
function rename(server) {
  const name = element('input', {value:server.name, maxlength:'160', required:'', dir:'auto'});
  const error = formError();
  const form = element('form', {class:'form'}, field('Name', name), error,
    element('div', {class:'form-actions'}, button('Cancel', () => close()), element('button', {type:'submit', class:'primary', text:'Save'})));
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
    element('div', {class:'form-actions'}, button('Cancel', () => close()), button('Remove', () => {
      if (change(() => repo.deleteServers(ids))) { ids.forEach(id => pings.delete(id)); close(); renderRows(); }
    }, 'danger')));
}
function serverMenu(server) {
  if (!server) return;
  detailsOpened = false;
  const active = state.running && state.profileId === server.id;
  const menu = [];
  if (!active) menu.push(option('power', state.running ? 'Connect to this server' : 'Connect', () => {
    if (!change(() => repo.setSelected(server.id))) return;
    close(); connect(server);
  }));
  menu.push(
    option('activity', 'Ping server', () => { close(); ping([server]); }),
    option('star', server.favorite ? 'Remove from favorites' : 'Add to favorites',
      () => { if (change(() => repo.toggleFavorite(server.id))) close(); }),
    option('pin', server.pinned ? 'Unpin' : 'Pin to top', () => { if (change(() => repo.togglePin(server.id))) close(); }),
    option('edit', 'Rename', () => rename(server)),
  );
  if (!server.subscriptionId) menu.push(option('edit', 'Edit configuration', () => manualForm(server)));
  else menu.push(option('plus', 'Duplicate as editable config', () => {
    if (change(() => repo.duplicateManual(server.id))) close();
  }));
  menu.push(
    option('copy', 'Copy config', () => { fire('copy', {text:server.uri, sensitive:true}); close(); toast('Config copied'); }),
    option('share', 'Share config', () => { close(); fire('share', {text:server.uri}); }),
    option('history', 'Exit IP history', () => history(server.id)),
    option('delete', server.subscriptionId ? 'Hide server' : 'Delete server', () => confirmRemove([server.id])),
  );
  show(displayServerName(server), ...menu);
}
function setFilter(value, subscriptionId = '') {
  filter = value;
  source = subscriptionId;
  limit = 120;
  renderRows();
}
function chooseSource() {
  const select = id => { setFilter('subscriptions', id); close(); };
  const entries = db.subscriptions.length
    ? [option('list', 'All subscriptions', () => select('')),
      ...db.subscriptions.map(sub => option('link', sub.name, () => select(sub.id)))]
    : [note('Your subscriptions will appear here.'), option('plus', 'Add subscription', () => subscriptionForm())];
  show('Subscriptions', ...entries);
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
    option('link', 'Manage subscriptions', subscriptions));
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
  const rounds = preferences.pings;
  let responded = false;
  try {
    for (let round = 0; round < rounds; round++) {
      const timeout = round > 0 && round === rounds - 1 && !responded ? 10 : 5;
      for (let offset = 0; offset < targets.length; offset += 5) {
        if (token !== lastPingToken) return;
        const batch = targets.slice(offset, offset + 5);
        const tested = await request('ping', {profiles:batch, timeout});
        if (token !== lastPingToken) return;
        batch.forEach((item, index) => {
          const values = results.get(item.id);
          const sample = tested?.[index];
          values.push(sample?.success && Number.isFinite(sample.delay) && sample.delay >= 0 ? sample.delay : -1);
          const good = values.filter(delay => delay >= 0);
          responded ||= good.length > 0;
          pings.set(item.id, {average:good.length ? Math.round(good.reduce((a,b) => a+b, 0) / good.length) : null,
            count:good.length, attempted:values.length});
          renderPingCell(item.id);
        });
      }
    }
  } catch (error) { if (token === lastPingToken) toast(safeError(error)); }
  finally {
    if (token === lastPingToken) { measuring = new Set(); renderRows(); }
  }
}
function cancelPing() {
  ++lastPingToken;
  for (const id of measuring) if (!pings.has(id) && stableScores.has(id)) pings.set(id, stableScores.get(id));
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
  const wheel = element('div', {class:'wheel', hidden:''});
  let selector, wheelFrame;
  const updateWheel = () => {
    wheel.hidden = preferences.palette !== 'custom';
    if (wheel.hidden || selector || wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      if (wheel.hidden || !wheel.isConnected) return;
      const canvas = element('canvas', {width:'196', height:'196', 'aria-label':'Color wheel'});
      const target = selectField([['themePrimary','Primary'],['themeAccent','Accent']], 'themePrimary');
      const brightness = element('input', {type:'range', min:'0', max:'100', 'aria-label':'Brightness'});
      const hex = element('input', {type:'text', maxlength:'7', autocomplete:'off', spellcheck:'false', 'aria-label':'Hex color'});
      const preview = element('span', {class:'wheel-preview', 'aria-hidden':'true'});
      wheel.append(canvas, element('div', {class:'wheel-fields'}, field('Color', target),
        field('Brightness', brightness), field('HEX', hex), preview));
      selector = attachColorWheel({canvas,target,brightness,hex,preview,read:key => preferences[key],
        write:(key,value) => { preferences[key] = value; setColors(); selector.refresh(); }, commit:persistPrefs});
      selector.refresh();
    });
  };
  for (const key of THEME_PALETTES) {
    const control = element('button', {type:'button', 'data-theme-palette':key,
      'aria-pressed':String(preferences.palette === key), click:() => {
        preferences.palette = key; persistPrefs(); setColors();
        for (const item of palette.children) item.setAttribute('aria-pressed', String(item.dataset.themePalette === key));
        updateWheel();
      }}, element('span', {class:'theme-swatch ' + key}), document.createTextNode(paletteNames[key]));
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
      option('activity', 'Connection notification', () => fire('notificationSettings')),
      option('grid', 'Add Quick Settings tile', () => fire('tile')),
      option('power', 'Always-on VPN and block outside tunnel', () => fire('vpnSettings')),
      option('routing', 'Routing rules', routing)),
    group('Subscriptions', option('link', 'Manage subscriptions', subscriptions)),
    group('Data', option('file', 'Portable Backup', backupMenu)),
    group('Support', option('file', 'Error report', diagnostics), note('SimpleRAY Android 0.2.0-beta.2')),
  );
  updateWheel();
}
function backupMenu() {
  detailsOpened = false;
  show('Portable Backup',
    note('Back up servers, subscriptions, favorites and pins. The file contains server credentials.'),
    option('down', 'Save backup file', () => fire('saveBackup')),
    option('share', 'Share backup file', () => writeBackup('shareBackup')),
    option('file', 'Restore from backup', () => fire('openBackup')));
}

async function writeBackup(action) {
  try {
    await request(action, {text:createPortableBackup(db)});
    if (action === 'writeBackup') {
      close();
      toast('Backup file saved');
    }
  } catch (failure) {
    show('Portable Backup', formError(safeError(failure)), button('Back', backupMenu));
  }
}

function confirmRestore(text) {
  detailsOpened = false;
  let backup;
  try { backup = readPortableBackup(String(text).trim()); }
  catch (failure) {
    show('Portable Backup', formError(safeError(failure)), button('Back', backupMenu));
    return;
  }
  const error = formError();
  const replacing = db.servers.length || db.subscriptions.length;
  const restore = button(replacing ? 'Replace profiles' : 'Restore profiles', () => {
    poll();
    if (state.running || pendingUntil > Date.now()) {
      error.textContent = 'Disconnect the VPN before restoring a backup.';
      return;
    }
    try {
      repo.restoreProfiles(backup);
      profilesRevision++;
      ++lastPingToken;
      measuring.clear();
      pings.clear();
      selection.clear();
      filter = 'all';
      source = query = $('search').value = '';
      limit = 120;
      sync();
      close();
      toast('Backup restored');
    } catch (failure) { error.textContent = safeError(failure); }
  }, 'primary');
  show('Restore backup',
    note(backup.servers.length + ' servers · ' + backup.subscriptions.length + ' subscriptions'),
    replacing ? note('Restoring replaces the servers and subscriptions currently on this device.') : null,
    error, element('div', {class:'form-actions'}, button('Cancel', () => close()), restore));
}

function normalizeDomain(value) {
  const text = String(value).trim().toLowerCase().replace(/^\.+/, '');
  const parsed = new URL(text.includes('://') ? text : 'https://' + text);
  const host = parsed.hostname.replace(/\.$/, '');
  if (!host || host.length > 253 || !host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))
      || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error('Enter a website or domain suffix');
  return host;
}
function routing() {
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
        iconButton('delete', 'Remove ' + rule.host, () => { current.domains.splice(index, 1); redrawRules(); }))));
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
  let installedApps;
  function showApps(apps) {
    const term = search.value.trim().toLowerCase();
    const matches = apps.filter(app => (app.label + ' ' + app.id).toLowerCase().includes(term));
    appList.replaceChildren(...matches.map(app => switchLine(app.label, checked.has(app.id), on => {
      if (on) checked.add(app.id); else checked.delete(app.id);
    })));
    if (!matches.length) appList.append(note('No matching apps'));
  }
  async function loadApps() {
    if (installedApps || appPanel.hidden) return;
    installedApps = request('apps');
    try { showApps(await installedApps); }
    catch {
      installedApps = undefined;
      appList.replaceChildren(note('Could not read the app list.'));
    }
  }
  search.addEventListener('input', async () => {
    try { if (installedApps) showApps(await installedApps); } catch {}
  });
  mode.addEventListener('change', loadApps);
  loadApps();
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
const sessionTraffic = () => 'Downloaded ' + formatBytes(state.down ?? 0) + ' · Uploaded ' + formatBytes(state.up ?? 0);
function details() {
  detailsOpened = true;
  const row = element('div', {class:'list-entry'}, element('strong', {text:'Connection status'}),
    element('p', {class:'note', id:'detail-current', text:phases[state.phase]}));
  const progress = note(downloadResult || 'Downloads up to 3 MB through the active VPN.');
  const test = element('button', {type:'button', class:'text-button icon-text', click:async () => {
    test.disabled = true;
    progress.textContent = 'Measuring…';
    try {
      const measured = await request('download');
      downloadResult = formatBytes(measured.bytes) + ' · ' + bytesPerSecond(measured.bytes * 1000 / measured.ms);
      progress.textContent = downloadResult;
    } catch (failure) { progress.textContent = safeError(failure); }
    finally { test.disabled = false; }
  }}, icon('down'), 'Test download');
  show('Connection details', row,
    group('Traffic this session', element('p', {class:'note', id:'detail-traffic', text:sessionTraffic()}),
      test, progress),
    option('activity', 'Refresh live latency', () => { fire('live'); toast('Checking the active server…'); }),
    option('history', 'Exit IP history', () => history(state.profileId || db.selectedId)),
    option('clipboard', 'Copy diagnostics', diagnostics));
}
function diagnostics() {
  detailsOpened = false;
  const platform = 'Android VPN';
  const message = [
    'SimpleRAY 0.2.0-beta.2', platform,
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
$('ping-all').addEventListener('click', () => {
  if (measuring.size) { cancelPing(); return; }
  const rows = selection.size ? records.filter(row => selection.has(row.id)) : getRows();
  selection.clear();
  ping(rows);
});
$('suggestion').querySelector('button').addEventListener('click', () => fire(state.suggestion ? 'switch' : 'undo'));
$('connect').addEventListener('click', () => state.running ? fire('disconnect') : connect());
for (const item of document.querySelectorAll('[data-filter]'))
  item.addEventListener('click', () => setFilter(item.dataset.filter));

setColors();
sync();
poll();
if (native) {
  setInterval(poll, 1000);
  document.addEventListener('visibilitychange', poll);
  setInterval(scheduledRefresh, 60_000);
  setTimeout(scheduledRefresh, 7000);
}
