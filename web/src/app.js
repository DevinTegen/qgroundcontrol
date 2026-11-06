import { WebSerialTransport, WebSocketTransport, webSerialSupported } from './transport.js';
import { Vehicle } from './vehicle.js';
import { loadParamDocs, optionsText, valueLabel } from './docs.js';
import { MAV_PARAM_TYPE } from './mavlink.js';
import { initFly } from './fly.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ link presets

const ELRS_GUIDE = 'https://www.expresslrs.org/software/mavlink/';
const MLRS_DOCS = 'https://github.com/olliw42/mLRS-docu';

const LINKS = {
  mlrs: {
    transports: {
      usb: { label: 'USB cable', hint: 'To the mLRS Tx module\'s serial/USB port', baud: 115200, bauds: [57600, 115200, 230400, 460800] },
      wifi: { label: 'Wi-Fi', hint: 'Module\'s Wi-Fi bridge (AIGC bridge firmware)', url: 'ws://192.168.4.55/mavlink' },
    },
    checklist: [
      'Flight controller: the serial port wired to the mLRS receiver uses <code>SERIALn_PROTOCOL = 2</code> (MAVLink 2) at the same baud as the receiver\'s serial baudrate.',
      'mLRS receiver: serial link mode set to <b>mavlink</b> (or mavlinkX).',
      'USB: set the Tx module\'s serial destination to the port you plug in, and pick the matching baud below.',
      'Wi-Fi: set <b>Tx Ser Dest = wbridge</b>. Browsers can\'t use plain UDP, so the module\'s Wi-Fi chip needs the AIGC bridge firmware (in development).',
      `More: <a href="${MLRS_DOCS}" target="_blank" rel="noopener">mLRS documentation</a>`,
    ],
  },
  elrs: {
    transports: {
      usb: { label: 'USB cable', hint: 'To the ELRS TX module (external modules)', baud: 460800, bauds: [115200, 230400, 460800] },
      wifi: { label: 'Wi-Fi', hint: 'TX backpack Wi-Fi (AIGC bridge firmware)', url: 'ws://10.0.0.1/mavlink' },
    },
    checklist: [
      'ELRS 3.5 or newer on TX and receiver (TX backpack 1.5+ for Wi-Fi).',
      'ELRS Lua → <b>Link Mode = MAVLink</b>. This forces hybrid switches and a 1:2 telemetry ratio.',
      'Flight controller: the serial port wired to the receiver uses <code>SERIALn_PROTOCOL = 2</code> at the receiver\'s MAVLink baud.',
      'Wi-Fi: Backpack → <b>Telemetry = WiFi</b>. Stock backpack firmware only speaks UDP, which browsers can\'t use; the AIGC bridge firmware adds a browser connection (in development).',
      `More: <a href="${ELRS_GUIDE}" target="_blank" rel="noopener">ELRS MAVLink guide</a>`,
    ],
  },
  sitl: {
    transports: {
      wifi: { label: 'Simulator bridge', hint: 'AIGC bridge in front of ArduPilot SITL (local or Codespace)', url: 'ws://127.0.0.1:5761/mavlink' },
    },
    checklist: [
      'Start the simulator with <code>tools/aigc/run_sitl.sh plane</code> (or <code>copter</code>), or open the AIGC SITL Codespace. See the README.',
      'When the page is opened from the simulator\'s own address, the connection is filled in for you.',
      'Fly from the Fly tab with your TX15 in USB Joystick mode, or the keyboard. Parameter changes can be written while flying in the simulator.',
    ],
  },
  direct: {
    transports: {
      usb: { label: 'USB cable', hint: 'Straight into the flight controller', baud: 115200, bauds: [57600, 115200, 230400, 460800, 921600] },
    },
    checklist: [
      'Plug the flight controller into this computer with a data-capable USB cable.',
      'Native USB ignores the baud rate; any value works.',
      'Close Mission Planner/QGroundControl first: only one program can open the port.',
    ],
  },
};

const settings = (() => {
  try { return JSON.parse(localStorage.getItem('aigc.connect') || '{}'); } catch { return {}; }
})();
const saveSettings = () => { try { localStorage.setItem('aigc.connect', JSON.stringify(settings)); } catch { /* private mode */ } };
settings.link ||= 'mlrs';
settings.transport ||= 'usb';

/// When this page is served by an AIGC bridge (simulator, Codespace or radio module), connect back to it.
const sameOriginBridgeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mavlink`;
let bridgeInfo = null;
fetch('aigc-bridge.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((info) => {
  if (!info) return;
  bridgeInfo = info;
  const link = info.sitl ? 'sitl' : (info.link || settings.link);
  settings.link = link;
  settings.transport = 'wifi';
  settings[`url.${link}`] = sameOriginBridgeUrl;
  const banner = document.createElement('div');
  banner.className = 'bridge-banner';
  banner.innerHTML = `<b>${info.sitl ? 'Simulator ready' : 'Connected to the module'}</b>: this page is served by the AIGC bridge (${esc(info.upstream || '')}). Press Connect.`;
  $('#connectView .lead').after(banner);
  renderConnect();
}).catch(() => { /* not served by a bridge */ });

// ------------------------------------------------------------------ app state

let vehicle = null;
let docs = { docs: new Map(), label: '', exact: false };
const pending = new Map(); // name -> {value, reason}
let filter = 'all';
let selected = null;
const rcMoving = new Map(); // channel -> timestamp
const rcBaseline = [];
let lastMoved = 0;

// ------------------------------------------------------------------ connect view

function renderConnect() {
  for (const b of document.querySelectorAll('#linkChoices .choice')) {
    b.setAttribute('aria-checked', String(b.dataset.link === settings.link));
  }
  const link = LINKS[settings.link];
  if (!link.transports[settings.transport]) settings.transport = Object.keys(link.transports)[0];

  $('#transportChoices').innerHTML = Object.entries(link.transports).map(([key, t]) => {
    const disabled = key === 'usb' && !webSerialSupported();
    return `<button class="choice" data-transport="${key}" role="radio" aria-checked="${key === settings.transport}" ${disabled ? 'disabled' : ''}>
      <b>${esc(t.label)}</b><small>${esc(t.hint)}</small></button>`;
  }).join('');

  const t = link.transports[settings.transport];
  let opts = '';
  if (settings.transport === 'usb') {
    const baud = settings[`baud.${settings.link}`] || t.baud;
    opts = `<label>Baud rate<select id="baudSelect">${t.bauds.map((b) => `<option ${b === baud ? 'selected' : ''}>${b}</option>`).join('')}</select></label>`;
    if (!webSerialSupported()) {
      opts += '<span class="note">USB needs Chrome or Edge on a computer (Web Serial). Safari, Firefox and phones can\'t open serial ports.</span>';
    }
  } else {
    const url = settings[`url.${settings.link}`] || t.url;
    opts = `<label>Bridge address<input id="wsUrl" size="34" value="${esc(url)}"></label>
      <span class="note">Join the module's Wi-Fi first. Needs the AIGC bridge firmware on the module's Wi-Fi chip (in development).</span>
      ${location.protocol === 'https:' && !location.hostname.endsWith('.app.github.dev') && !bridgeInfo ? '<span class="note">This copy of the app is loaded over https, and browsers block unencrypted Wi-Fi links from https pages. Use the copy served by the module itself (the popup when you join its Wi-Fi), or USB.</span>' : ''}`;
  }
  $('#transportOptions').innerHTML = opts;
  $('#checklist').innerHTML = link.checklist.map((c) => `<li>${c}</li>`).join('');
}

$('#linkChoices').addEventListener('click', (e) => {
  const b = e.target.closest('.choice');
  if (!b) return;
  settings.link = b.dataset.link;
  saveSettings();
  renderConnect();
});

$('#transportChoices').addEventListener('click', (e) => {
  const b = e.target.closest('.choice');
  if (!b || b.disabled) return;
  settings.transport = b.dataset.transport;
  saveSettings();
  renderConnect();
});

$('#transportOptions').addEventListener('change', (e) => {
  if (e.target.id === 'baudSelect') settings[`baud.${settings.link}`] = Number(e.target.value);
  if (e.target.id === 'wsUrl') settings[`url.${settings.link}`] = e.target.value.trim();
  saveSettings();
});

$('#connectBtn').addEventListener('click', connect);
$('#disconnectBtn').addEventListener('click', () => disconnect('Disconnected'));

function setPill(text, kind) {
  const pill = $('#linkPill');
  pill.textContent = text;
  pill.className = `pill pill-${kind}`;
}

async function connect() {
  $('#connectError').textContent = '';
  const link = LINKS[settings.link];
  const t = link.transports[settings.transport];
  const transport = settings.transport === 'usb'
    ? new WebSerialTransport(Number($('#baudSelect')?.value || t.baud))
    : new WebSocketTransport(($('#wsUrl')?.value || t.url).trim());

  $('#connectBtn').disabled = true;
  setPill('Connecting…', 'warn');
  try {
    await transport.connect();
    vehicle = new Vehicle(transport);
    transport.onClose = (why) => disconnect(why);
    wireVehicle(vehicle);
    await vehicle.start();
  } catch (e) {
    $('#connectError').textContent = e.message || String(e);
    setPill('Not connected', 'off');
    vehicle?.stop();
    try { await transport.close(); } catch { /* ignore */ }
    vehicle = null;
    $('#connectBtn').disabled = false;
    return;
  }
  $('#connectBtn').disabled = false;
  $('#connectView').hidden = true;
  $('#appView').hidden = false;
  $('#disconnectBtn').hidden = false;
  setPill(`${{ direct: 'USB', sitl: 'SITL', mlrs: 'mLRS', elrs: 'ELRS' }[settings.link]} · ${transport.label}`, 'on');
  await loadEverything();
}

async function disconnect(why) {
  if (!vehicle) return;
  const v = vehicle;
  vehicle = null;
  v.stop();
  try { await v.transport.close(); } catch { /* already closed */ }
  pending.clear();
  updatePending();
  $('#appView').hidden = true;
  $('#connectView').hidden = false;
  $('#disconnectBtn').hidden = true;
  $('#vehicleSummary').innerHTML = '';
  setPill('Not connected', 'off');
  if (why && why !== 'Disconnected') $('#connectError').textContent = why;
}

const fly = initFly({ getVehicle: () => vehicle, onStatus: (text) => { $('#flyStatus').textContent = text; } });

function wireVehicle(v) {
  fly.attach(v);
  v.addEventListener('state', renderSummary);
  v.addEventListener('param', (e) => updateParamRow(e.detail.name));
  v.addEventListener('rc', onRc);
  v.addEventListener('statustext', renderMessages);
  v.pillTimer = setInterval(() => {
    if (vehicle !== v) {
      clearInterval(v.pillTimer);
      return;
    }
    setPill(v.linkAlive ? $('#linkPill').textContent.replace(' (no heartbeat)', '') : `${$('#linkPill').textContent.replace(' (no heartbeat)', '')} (no heartbeat)`, v.linkAlive ? 'on' : 'warn');
  }, 1000);
}

function renderSummary() {
  if (!vehicle) return;
  const s = vehicle.state;
  const parts = [];
  if (s.docsName) parts.push(`<span><b>${esc(s.docsName)}</b> ${esc(s.version || '')}${s.version && s.versionType !== 255 ? ' (dev)' : ''}</span>`);
  if (s.mode) parts.push(`<span>Mode <b>${esc(s.mode)}</b></span>`);
  parts.push(s.armed ? '<span class="armed">ARMED</span>' : '<span>Disarmed</span>');
  if (s.battery) parts.push(`<span><b>${s.battery.toFixed(2)}</b> V</span>`);
  $('#vehicleSummary').innerHTML = parts.join('');
}

// ------------------------------------------------------------------ loading

function showProgress(fraction, text) {
  const p = $('#progress');
  p.hidden = fraction === null;
  if (fraction !== null) {
    p.querySelector('.progress-bar').style.width = `${Math.round(fraction * 100)}%`;
    p.querySelector('span').textContent = text;
  }
}

async function loadEverything() {
  const v = vehicle;
  showProgress(0, 'Downloading parameters…');
  const docsPromise = loadParamDocs(v.state.docsName, v.state.version, v.state.versionType === 255).then((d) => {
    docs = d;
    renderDocsLine();
  });
  await v.downloadParams((have, total, unit) => {
    if (!total) return;
    showProgress(have / total, unit === 'bytes'
      ? `Downloading parameters (MAVLink FTP) ${Math.round(have / 1024)} / ${Math.round(total / 1024)} kB`
      : `Downloading parameters ${have} / ${total}`);
  });
  showProgress(null);
  await docsPromise;
  renderDocsLine();
  renderParams();
  renderRc();
}

function renderDocsLine() {
  const src = vehicle?.paramSource === 'ftp' ? 'Defaults reported by the vehicle.' : vehicle?.paramSource === 'list' ? 'Vehicle did not report defaults (needs ArduPilot 4.1+ with MAVLink FTP), so Modified can\'t be shown.' : '';
  $('#docsLine').innerHTML = docs.label
    ? `Parameter docs: <span class="${docs.exact ? 'exact' : 'approx'}">${esc(docs.label)}</span>. ${esc(src)}`
    : 'Loading parameter docs…';
}

// ------------------------------------------------------------------ parameters

function isFloatType(p) {
  return p.type === MAV_PARAM_TYPE.REAL32;
}

function fmt(p, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '';
  if (!isFloatType(p)) return String(Math.round(value));
  return String(Number(Number(value).toPrecision(7)));
}

function nearlyEqual(a, b) {
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
}

function isModified(p) {
  return p.def !== undefined && !nearlyEqual(p.value, p.def);
}

function isUndocumented(name) {
  return docs.docs.size > 0 && !docs.docs.has(name);
}

function paramMatches(name, p, terms) {
  if (filter === 'modified' && !isModified(p)) return false;
  if (filter === 'undocumented' && !isUndocumented(name)) return false;
  if (!terms.length) return true;
  const d = docs.docs.get(name);
  const hay = `${name} ${d?.DisplayName || ''} ${d?.Description || ''}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

function rowHtml(name, p) {
  const d = docs.docs.get(name);
  const pend = pending.get(name);
  const shown = pend ? pend.value : p.value;
  const label = valueLabel(d, shown);
  const cls = ['value', isModified(p) ? 'modified' : '', pend ? 'pending' : ''].join(' ');
  const opts = optionsText(d);
  return `<tr data-name="${esc(name)}" class="${name === selected ? 'selected' : ''}">
    <td class="name">${esc(name)}</td>
    <td class="${cls}"><span class="v">${esc(fmt(p, shown))}</span>${label ? ` <span class="muted">${esc(label)}</span>` : ''}</td>
    <td class="muted">${p.def !== undefined ? esc(fmt(p, p.def)) : ''}</td>
    <td class="muted">${esc(d?.Units || '')}</td>
    <td class="options"><span class="clip" title="${esc(opts)}">${esc(opts)}</span></td>
    <td class="desc ${d ? '' : 'undoc'}"><span class="clip">${d ? esc(d.DisplayName || '') : (docs.docs.size ? 'Not in the docs for this version' : '')}</span></td></tr>`;
}

function renderParams() {
  if (!vehicle) return;
  const terms = $('#paramSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const names = [...vehicle.params.keys()].sort();
  const rows = [];
  let modified = 0;
  let undoc = 0;
  for (const name of names) {
    const p = vehicle.params.get(name);
    if (isModified(p)) modified++;
    if (isUndocumented(name)) undoc++;
    if (paramMatches(name, p, terms)) rows.push(rowHtml(name, p));
  }
  $('#paramRows').innerHTML = rows.join('');
  $('#modifiedCount').textContent = vehicle.paramSource === 'ftp' ? `(${modified})` : '';
  $('#undocCount').textContent = docs.docs.size ? `(${undoc})` : '';
  const empty = $('#paramEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = filter === 'modified' && vehicle.paramSource !== 'ftp'
    ? 'This vehicle did not report default values, so modified parameters can\'t be identified.'
    : 'No parameters match.';
}

function updateParamRow(name) {
  const row = document.querySelector(`#paramRows tr[data-name="${CSS.escape(name)}"]`);
  const p = vehicle?.params.get(name);
  if (row && p) row.outerHTML = rowHtml(name, p);
  if (name === selected) renderDetails();
  if (/^(RC\d+_|RCMAP_|FLTMODE_CH|MODE_CH)/.test(name)) renderRcMapping();
}

let searchTimer;
$('#paramSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderParams, 150);
});

document.querySelector('.seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.filter;
  for (const x of document.querySelectorAll('.seg button')) x.setAttribute('aria-checked', String(x === b));
  renderParams();
});

$('#paramRows').addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  selected = row.dataset.name;
  for (const r of document.querySelectorAll('#paramRows tr.selected')) r.classList.remove('selected');
  row.classList.add('selected');
  renderDetails();
  if (e.target.closest('td.value')) openEditor(selected);
});

function renderDetails() {
  const box = $('#paramDetails');
  const p = vehicle?.params.get(selected);
  if (!p) return;
  const d = docs.docs.get(selected);
  const opts = optionsText(d);
  const pend = pending.get(selected);
  box.innerHTML = `
    <h3>${esc(selected)}</h3>
    <div class="display">${esc(d?.DisplayName || '')}</div>
    <p>${d ? esc(d.Description || '') : `<span class="warn">Not in the parameter docs loaded for this firmware (${esc(docs.label)}). It may have been added, renamed or removed in this version.</span>`}</p>
    <dl>
      <dt>Value</dt><dd>${esc(fmt(p, p.value))} ${esc(d?.Units || '')} ${esc(valueLabel(d, p.value))}</dd>
      ${pend ? `<dt>Pending</dt><dd class="warn">${esc(fmt(p, pend.value))} ${esc(valueLabel(d, pend.value))}</dd>` : ''}
      ${p.def !== undefined ? `<dt>Default</dt><dd>${esc(fmt(p, p.def))} ${esc(valueLabel(d, p.def))}</dd>` : ''}
      ${d?.Range ? `<dt>Range</dt><dd>${esc(d.Range.low)} – ${esc(d.Range.high)}</dd>` : ''}
      ${d?.Increment ? `<dt>Increment</dt><dd>${esc(d.Increment)}</dd>` : ''}
      ${d?.RebootRequired ? '<dt>Reboot</dt><dd class="warn">Required after change</dd>' : ''}
      ${d?.ReadOnly ? '<dt>Access</dt><dd>Read-only</dd>' : ''}
    </dl>
    ${opts ? `<div class="opts">${esc(opts)}</div>` : ''}
    <div class="row">
      <button class="btn btn-primary" id="detailEdit" ${d?.ReadOnly ? 'disabled' : ''}>Edit…</button>
      <button class="btn" id="detailReset" ${p.def === undefined || !isModified(p) ? 'disabled' : ''}>Reset to default</button>
    </div>`;
  $('#detailEdit').onclick = () => openEditor(selected);
  $('#detailReset').onclick = () => stage(selected, p.def, 'Reset to firmware default');
}

// ------------------------------------------------------------------ editing

function openEditor(name) {
  const p = vehicle.params.get(name);
  const d = docs.docs.get(name);
  if (d?.ReadOnly) return;
  const current = pending.get(name)?.value ?? p.value;
  $('#editTitle').textContent = name;
  $('#editDesc').textContent = d ? `${d.DisplayName || ''}${d.Units ? ` (${d.Units})` : ''}` : 'Not in the loaded docs';
  $('#editError').textContent = '';
  let control;
  if (d?.Bitmask) {
    control = `<div class="bits">${Object.entries(d.Bitmask).map(([bit, label]) => `<label class="inline"><input type="checkbox" data-bit="${bit}" ${(Number(current) >>> 0) & (1 << Number(bit)) ? 'checked' : ''}> ${esc(bit)}: ${esc(label)}</label>`).join('')}</div>`;
  } else if (d?.Values) {
    const entries = Object.entries(d.Values);
    const known = entries.some(([k]) => Number(k) === Number(current));
    control = `<select id="editValue">${known ? '' : `<option value="${esc(current)}" selected>${esc(fmt(p, current))} (not in docs)</option>`}${entries.map(([k, v]) => `<option value="${esc(k)}" ${Number(k) === Number(current) ? 'selected' : ''}>${esc(k)}: ${esc(v)}</option>`).join('')}</select>`;
  } else {
    control = `<input id="editValue" type="number" step="any" value="${esc(fmt(p, current))}">
      ${d?.Range ? `<span class="muted">Range ${esc(d.Range.low)} – ${esc(d.Range.high)}${d.Increment ? `, step ${esc(d.Increment)}` : ''}</span>` : ''}`;
  }
  $('#editControl').innerHTML = control;
  const dlg = $('#editDialog');
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    let value;
    if (d?.Bitmask) {
      value = [...dlg.querySelectorAll('[data-bit]')].reduce((acc, cb) => (cb.checked ? acc | (1 << Number(cb.dataset.bit)) : acc), 0);
    } else {
      value = Number($('#editValue').value);
    }
    if (!Number.isFinite(value)) return;
    stage(name, value, 'Edited by you');
  };
  dlg.showModal();
}

function stage(name, value, reason) {
  const p = vehicle?.params.get(name);
  if (!p) return false;
  if (!isFloatType(p)) value = Math.round(value);
  if (nearlyEqual(value, p.value)) {
    pending.delete(name);
  } else {
    pending.set(name, { value, reason });
  }
  updatePending();
  updateParamRow(name);
  return true;
}

function updatePending() {
  const bar = $('#pendingBar');
  bar.hidden = pending.size === 0;
  $('#pendingText').textContent = `${pending.size} pending change${pending.size === 1 ? '' : 's'}`;
}

$('#pendingDiscard').addEventListener('click', () => {
  const names = [...pending.keys()];
  pending.clear();
  updatePending();
  names.forEach(updateParamRow);
});

$('#pendingReview').addEventListener('click', openReview);

function rangeProblem(d, value) {
  if (!d?.Range) return '';
  const lo = Number(d.Range.low);
  const hi = Number(d.Range.high);
  return value < lo || value > hi ? `Outside the documented range ${d.Range.low} – ${d.Range.high}` : '';
}

function openReview() {
  const list = $('#reviewList');
  const armed = vehicle?.state.armed && !vehicle?.isSitl;
  $('#armedWarning').hidden = !armed;
  $('#writeBtn').disabled = armed;
  list.innerHTML = [...pending.entries()].map(([name, ch]) => {
    const p = vehicle.params.get(name);
    const d = docs.docs.get(name);
    const from = `${fmt(p, p.value)}${valueLabel(d, p.value) ? ` (${valueLabel(d, p.value)})` : ''}`;
    const to = `${fmt(p, ch.value)}${valueLabel(d, ch.value) ? ` (${valueLabel(d, ch.value)})` : ''}`;
    const warn = rangeProblem(d, ch.value);
    return `<div class="review-item" data-name="${esc(name)}">
      <input type="checkbox" checked aria-label="Include ${esc(name)}">
      <div><span class="n">${esc(name)}</span> <span class="muted">${esc(d?.DisplayName || '')}</span><br>
      <span class="chg">${esc(from)} → ${esc(to)} ${esc(d?.Units || '')}</span>${d?.RebootRequired ? ' <span class="warn">· reboot required</span>' : ''}</div>
      ${ch.reason ? `<div class="why">${esc(ch.reason)}</div>` : ''}
      ${warn ? `<div class="bad">${esc(warn)}</div>` : ''}
      <div class="res"></div></div>`;
  }).join('');
  const dlg = $('#reviewDialog');
  dlg.onclose = null;
  dlg.showModal();
}

$('#writeBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const btn = $('#writeBtn');
  btn.disabled = true;
  for (const item of document.querySelectorAll('#reviewList .review-item')) {
    const name = item.dataset.name;
    const res = item.querySelector('.res');
    if (!item.querySelector('input').checked) {
      res.textContent = 'Skipped';
      continue;
    }
    try {
      const confirmed = await vehicle.setParam(name, pending.get(name).value);
      res.textContent = `Written: vehicle reports ${fmt(vehicle.params.get(name), confirmed)}`;
      res.className = 'res ok';
      pending.delete(name);
    } catch (err) {
      res.textContent = `Failed: ${err.message}`;
      res.className = 'res fail';
    }
  }
  updatePending();
  renderParams();
  btn.disabled = false;
  btn.textContent = 'Write to vehicle';
});

// ------------------------------------------------------------------ save

$('#saveParams').addEventListener('click', () => {
  if (!vehicle) return;
  const lines = [...vehicle.params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([n, p]) => `${n},${fmt(p, p.value)}`);
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${vehicle.state.docsName || 'vehicle'}-${vehicle.state.version || ''}-${new Date().toISOString().slice(0, 10)}.param`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#refreshParams').addEventListener('click', async () => {
  if (!vehicle) return;
  await loadEverything();
});

// ------------------------------------------------------------------ RC mapping

const AXES = [['Roll', 'RCMAP_ROLL'], ['Pitch', 'RCMAP_PITCH'], ['Throttle', 'RCMAP_THROTTLE'], ['Yaw', 'RCMAP_YAW']];

function pval(name) {
  const pend = pending.get(name);
  if (pend) return pend.value;
  return vehicle?.params.get(name)?.value;
}

function modeParam() {
  return vehicle?.params.has('FLTMODE_CH') ? 'FLTMODE_CH' : vehicle?.params.has('MODE_CH') ? 'MODE_CH' : null;
}

function channelFunctions(ch) {
  const f = AXES.filter(([, param]) => Math.round(pval(param)) === ch).map(([label]) => label);
  const mp = modeParam();
  if (mp && Math.round(pval(mp)) === ch) f.push('Flight modes');
  return f;
}

function renderRc() {
  const rows = [];
  for (let ch = 1; ch <= 16; ch++) {
    rows.push(`<tr data-ch="${ch}"><td>${ch}</td>
      <td><div class="bar"><div class="track"></div><div class="tick" data-k="min"></div><div class="tick" data-k="trim"></div><div class="tick" data-k="max"></div><div class="dot"></div></div></td>
      <td class="pwm">--</td><td class="func"></td><td class="assign"></td><td class="option"></td><td class="rev"></td><td class="conflict"></td></tr>`);
  }
  $('#rcRows').innerHTML = rows.join('');
  renderRcMapping();
}

const pwmX = (pwm) => `${Math.max(0, Math.min(1, (pwm - 800) / 1400)) * 100}%`;

function renderRcMapping() {
  if (!vehicle || !$('#rcRows').children.length) return;
  const axesOptions = [...AXES.map(([l]) => l), ...(modeParam() ? ['Flight modes'] : [])];
  for (let ch = 1; ch <= 16; ch++) {
    const row = $(`#rcRows tr[data-ch="${ch}"]`);
    const funcs = channelFunctions(ch);
    row.querySelector('.func').textContent = funcs.join(' + ') || '—';
    row.querySelector('.assign').innerHTML = `<select data-assign="${ch}" ${vehicle.state.armed ? 'disabled' : ''}><option value="">Assign…</option>${axesOptions.map((a) => `<option>${a}</option>`).join('')}</select>`;

    const optName = `RC${ch}_OPTION`;
    const optDoc = docs.docs.get(optName);
    const optVal = pval(optName);
    let optHtml = '';
    if (optVal !== undefined) {
      optHtml = optDoc?.Values
        ? `<select data-param="${optName}" ${vehicle.state.armed ? 'disabled' : ''}>${Object.entries(optDoc.Values).map(([k, v]) => `<option value="${esc(k)}" ${Number(k) === Math.round(optVal) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
        : `<input data-param="${optName}" type="number" value="${esc(optVal)}" style="width:6em">`;
    }
    row.querySelector('.option').innerHTML = optHtml;

    const revName = `RC${ch}_REVERSED`;
    row.querySelector('.rev').innerHTML = pval(revName) !== undefined ? `<input type="checkbox" data-param="${revName}" ${Math.round(pval(revName)) ? 'checked' : ''} ${vehicle.state.armed ? 'disabled' : ''}>` : '';

    let conflict = '';
    if (funcs.length > 1) conflict = 'Drives more than one function';
    else if (funcs.length && optVal && Math.round(optVal) !== 0) conflict = `Also has ${optName} set`;
    row.querySelector('.conflict').textContent = conflict;

    for (const k of ['min', 'trim', 'max']) {
      const v = pval(`RC${ch}_${k.toUpperCase()}`);
      const tick = row.querySelector(`.tick[data-k="${k}"]`);
      tick.hidden = v === undefined;
      if (v !== undefined) tick.style.left = pwmX(v);
    }
  }
}

$('#rcRows').addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.assign) {
    const ch = Number(t.dataset.assign);
    assignFunction(t.value, ch);
    t.value = '';
  } else if (t.dataset.param) {
    const value = t.type === 'checkbox' ? (t.checked ? 1 : 0) : Number(t.value);
    stage(t.dataset.param, value, 'Set on the RC Mapping page');
  }
  renderRcMapping();
});

function assignFunction(fn, ch) {
  const target = fn === 'Flight modes' ? modeParam() : AXES.find(([l]) => l === fn)?.[1];
  if (!target) return;
  const prev = Math.round(pval(target));
  if (fn !== 'Flight modes') {
    // Swap axes instead of leaving two on one channel.
    for (const [, param] of AXES) {
      if (param !== target && Math.round(pval(param)) === ch) stage(param, prev, `Swapped with ${fn} on the RC Mapping page`);
    }
  }
  stage(target, ch, `Channel ${ch} assigned to ${fn} on the RC Mapping page`);
}

let rcFrame = 0;
function onRc() {
  if (rcFrame) return;
  rcFrame = requestAnimationFrame(() => {
    rcFrame = 0;
    const now = Date.now();
    vehicle?.rc.forEach((pwm, i) => {
      const ch = i + 1;
      if (ch > 16) return;
      const row = $(`#rcRows tr[data-ch="${ch}"]`);
      if (!row) return;
      row.querySelector('.pwm').textContent = pwm && pwm !== 65535 ? pwm : '--';
      if (pwm && pwm !== 65535) row.querySelector('.dot').style.left = pwmX(pwm);
      if (rcBaseline[i] === undefined) rcBaseline[i] = pwm;
      if (Math.abs(pwm - rcBaseline[i]) >= 40 && pwm !== 65535) {
        rcBaseline[i] = pwm;
        rcMoving.set(ch, now);
        lastMoved = ch;
      }
      row.classList.toggle('moving', now - (rcMoving.get(ch) || 0) < 1500);
    });
    if (lastMoved) {
      const fn = channelFunctions(lastMoved).join(' + ');
      const el = $('#lastMoved');
      el.hidden = false;
      el.textContent = `Last moved: channel ${lastMoved}${fn ? ` (${fn})` : ''}`;
    }
  });
}

// ------------------------------------------------------------------ Ask Claude

function buildContext(includeAll) {
  const s = vehicle.state;
  const lines = [
    'I am tuning an ArduPilot vehicle using the AIGC web ground station.',
    `Vehicle: ${s.docsName} firmware ${s.version || 'unknown'}${s.versionType === 255 ? '' : ' (dev build)'}, flight mode ${s.mode}, ${s.armed ? 'ARMED' : 'disarmed'}.`,
    `Parameter docs in use: ${docs.label}. Parameter names change between firmware versions, so only use parameter names that appear below or that exist in ArduPilot ${s.docsName} ${s.version}.`,
    '',
    'When you suggest changes, list each one on its own line exactly like:',
    'PARAM_NAME = value  # short reason',
    'I will paste those lines back into the ground station and review each change before it is written.',
    '',
    includeAll ? 'All parameters (NAME = value [default] — description):' : 'Parameters that differ from the firmware default (NAME = value [default] — description):',
  ];
  for (const [name, p] of [...vehicle.params.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!includeAll && !isModified(p)) continue;
    const d = docs.docs.get(name);
    const label = valueLabel(d, p.value);
    lines.push(`${name} = ${fmt(p, p.value)}${label ? ` (${label})` : ''}${p.def !== undefined ? ` [default ${fmt(p, p.def)}]` : ''}${d?.Units ? ` ${d.Units}` : ''} — ${d?.DisplayName || 'not in docs'}`);
  }
  if (!includeAll && vehicle.paramSource !== 'ftp') {
    lines.push('(This vehicle did not report defaults, so the modified list may be empty; ask me for specific parameters.)');
  }
  return lines.join('\n');
}

$('#copyContext').addEventListener('click', async () => {
  if (!vehicle) return;
  const text = buildContext($('#ctxIncludeAll').checked);
  try {
    await navigator.clipboard.writeText(text);
    $('#copyStatus').textContent = `Copied ${text.split('\n').length} lines. Paste them into Claude.`;
  } catch {
    $('#suggestions').value = text;
    $('#copyStatus').textContent = 'Clipboard blocked. The text is in the box on the right; copy it from there.';
  }
});

/// Parses "NAME = value  # reason" lines; enum labels are accepted as values.
function parseSuggestions(text) {
  const out = [];
  const errors = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^[\s>*\-•`]+|`+$/g, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]{1,15})\s*(?:=|:|,|\s)\s*([^#]+?)\s*(?:#\s*(.*))?$/);
    if (!m) continue;
    const [, name, rawValue, reason] = m;
    const p = vehicle.params.get(name);
    if (!p) { errors.push(`${name}: not a parameter on this vehicle`); continue; }
    let value = Number(rawValue);
    if (!Number.isFinite(value)) {
      const d = docs.docs.get(name);
      const hit = d?.Values && Object.entries(d.Values).find(([, label]) => label.toLowerCase() === rawValue.toLowerCase());
      if (!hit) { errors.push(`${name}: can't read value "${rawValue}"`); continue; }
      value = Number(hit[0]);
    }
    out.push({ name, value, reason: reason ? `Claude: ${reason}` : 'Suggested by Claude' });
  }
  return { out, errors };
}

$('#reviewSuggestions').addEventListener('click', () => {
  if (!vehicle) return;
  const { out, errors } = parseSuggestions($('#suggestions').value);
  for (const s of out) stage(s.name, s.value, s.reason);
  $('#suggestStatus').textContent = `${out.length} change${out.length === 1 ? '' : 's'} added${errors.length ? `; skipped: ${errors.join('; ')}` : ''}.`;
  if (pending.size) openReview();
});

// ------------------------------------------------------------------ messages & tabs

function renderMessages() {
  if (!vehicle) return;
  $('#messageList').innerHTML = vehicle.state.statustext.map((m) => `<li class="sev-${m.severity}">${m.t.toLocaleTimeString()}  ${esc(m.text)}</li>`).join('');
}

document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x === b));
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${b.dataset.tab}`;
  fly.show(b.dataset.tab === 'fly');
  if (b.dataset.tab === 'rc') renderRcMapping();
  if (b.dataset.tab === 'messages') renderMessages();
});

renderConnect();
