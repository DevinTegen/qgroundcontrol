// Fly tab: attitude/HUD, track map, roll/pitch tuning graph, arm/mode buttons, and stick input (simulator only)
// from a USB joystick (e.g. a RadioMaster TX15 in USB Joystick mode) or the keyboard.
import { MODES } from './vehicle.js';

const $ = (sel) => document.querySelector(sel);
const DEG = 180 / Math.PI;

const QUICK_MODES = {
  Plane: ['MANUAL', 'FBWA', 'CRUISE', 'AUTOTUNE', 'LOITER', 'RTL', 'TAKEOFF', 'QHOVER', 'QLOITER', 'QLAND'],
  Copter: ['STABILIZE', 'ALT_HOLD', 'LOITER', 'POSHOLD', 'AUTOTUNE', 'RTL', 'LAND', 'GUIDED'],
  Rover: ['MANUAL', 'ACRO', 'HOLD', 'LOITER', 'RTL'],
};

const HISTORY_S = 20;

export function initFly({ getVehicle, onStatus }) {
  const history = []; // {t, roll, pitch, navRoll, navPitch}
  const track = [];
  let active = false;
  let raf = 0;
  let sticksTimer = 0;
  const keys = new Set();
  let throttleKey = 0; // keyboard throttle is sticky, 0..1
  const sticks = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  const mapping = loadMapping();

  function loadMapping() {
    try {
      return { roll: 0, pitch: 1, throttle: 2, yaw: 3, invRoll: false, invPitch: true, invThrottle: true, invYaw: false, ...JSON.parse(localStorage.getItem('aigc.sticks') || '{}') };
    } catch {
      return { roll: 0, pitch: 1, throttle: 2, yaw: 3, invRoll: false, invPitch: true, invThrottle: true, invYaw: false };
    }
  }
  function saveMapping() {
    try { localStorage.setItem('aigc.sticks', JSON.stringify(mapping)); } catch { /* private mode */ }
  }

  // ---------------------------------------------------------------- controls

  function renderControls() {
    const v = getVehicle();
    if (!v) return;
    const modes = QUICK_MODES[v.state.docsName] || QUICK_MODES.Plane;
    const table = MODES[v.state.docsName] || MODES.Plane;
    const byName = Object.fromEntries(Object.entries(table).map(([n, name]) => [name, Number(n)]));
    const hasQ = v.params.has('Q_ENABLE') && Math.round(v.params.get('Q_ENABLE').value) === 1;
    $('#modeButtons').innerHTML = modes
      .filter((m) => byName[m] !== undefined && (!m.startsWith('Q') || hasQ))
      .map((m) => `<button class="btn mode-btn" data-mode="${byName[m]}">${m}</button>`).join('');
    $('#sticksCard').hidden = !v.isSitl;
    $('#flySimNote').hidden = !v.isSitl;
  }

  $('#modeButtons').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mode]');
    const v = getVehicle();
    if (!b || !v) return;
    const result = await v.setMode(Number(b.dataset.mode));
    onStatus(result === 0 ? `Mode ${b.textContent}` : `Mode change refused (${result ?? 'no answer'})`);
  });

  $('#armBtn').addEventListener('click', async () => {
    const v = getVehicle();
    if (!v) return;
    const arming = !v.state.armed;
    if (!v.isSitl && !confirm(arming ? 'Arm the real vehicle? Props may spin.' : 'Disarm the vehicle? If it is flying it will fall.')) return;
    const result = await v.arm(arming);
    onStatus(result === 0 ? (arming ? 'Armed' : 'Disarmed') : `${arming ? 'Arming' : 'Disarming'} refused (${result ?? 'no answer'}); see Messages for the reason`);
  });

  // ---------------------------------------------------------------- sticks (SITL only)

  function gamepad() {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    return pads[0] || null;
  }

  function readSticks() {
    const source = $('#stickSource').value;
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    if (source === 'gamepad') {
      const pad = gamepad();
      if (!pad) return false;
      const ax = (i, inv) => (pad.axes[i] ?? 0) * (inv ? -1 : 1);
      sticks.roll = ax(mapping.roll, mapping.invRoll);
      sticks.pitch = ax(mapping.pitch, mapping.invPitch);
      sticks.yaw = ax(mapping.yaw, mapping.invYaw);
      sticks.throttle = clamp((ax(mapping.throttle, mapping.invThrottle) + 1) / 2, 0, 1);
      $('#padAxes').textContent = `${pad.id.slice(0, 40)} · axes ${pad.axes.map((a, i) => `${i}:${a.toFixed(2)}`).join('  ')}`;
      return true;
    }
    if (source === 'keyboard') {
      const k = (a, b) => (keys.has(a) ? 1 : 0) - (keys.has(b) ? 1 : 0);
      sticks.roll = k('ArrowRight', 'ArrowLeft') * 0.6;
      sticks.pitch = k('ArrowDown', 'ArrowUp') * 0.6; // stick back = pitch up
      sticks.yaw = k('KeyD', 'KeyA') * 0.6;
      throttleKey = clamp(throttleKey + k('KeyW', 'KeyS') * 0.02, 0, 1);
      sticks.throttle = throttleKey;
      return true;
    }
    return false;
  }

  function sendSticks() {
    const v = getVehicle();
    if (!v || !v.isSitl) return;
    if (!readSticks()) {
      return;
    }
    const pwm = new Array(18).fill(0);
    const ch = (name, fallback) => Math.round(v.params.get(name)?.value ?? fallback) - 1;
    pwm[ch('RCMAP_ROLL', 1)] = Math.round(1500 + 500 * sticks.roll);
    pwm[ch('RCMAP_PITCH', 2)] = Math.round(1500 + 500 * sticks.pitch);
    pwm[ch('RCMAP_THROTTLE', 3)] = Math.round(1000 + 1000 * sticks.throttle);
    pwm[ch('RCMAP_YAW', 4)] = Math.round(1500 + 500 * sticks.yaw);
    v.rcOverride(pwm);
    $('#stickReadout').textContent = `Roll ${sticks.roll.toFixed(2)}  Pitch ${sticks.pitch.toFixed(2)}  Yaw ${sticks.yaw.toFixed(2)}  Throttle ${(sticks.throttle * 100).toFixed(0)}%`;
  }

  $('#stickSource').addEventListener('change', () => {
    const v = getVehicle();
    const src = $('#stickSource').value;
    $('#padMapping').hidden = src !== 'gamepad';
    $('#keyHelp').hidden = src !== 'keyboard';
    if (src === 'off' && v) v.rcOverride(new Array(18).fill(0)); // hand control back
    throttleKey = 0;
  });

  for (const [axis, label] of [['roll', 'Roll'], ['pitch', 'Pitch'], ['throttle', 'Throttle'], ['yaw', 'Yaw']]) {
    const inv = `inv${label}`;
    const el = document.createElement('label');
    el.innerHTML = `${label} axis <select data-axis="${axis}">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<option ${i === mapping[axis] ? 'selected' : ''}>${i}</option>`).join('')}</select>
      <span class="inline"><input type="checkbox" data-inv="${inv}" ${mapping[inv] ? 'checked' : ''}> reverse</span>`;
    $('#padMapping').appendChild(el);
  }
  $('#padMapping').addEventListener('change', (e) => {
    if (e.target.dataset.axis) mapping[e.target.dataset.axis] = Number(e.target.value);
    if (e.target.dataset.inv) mapping[e.target.dataset.inv] = e.target.checked;
    saveMapping();
  });

  window.addEventListener('keydown', (e) => {
    if (!active || $('#stickSource').value !== 'keyboard' || e.target.matches('input, textarea, select')) return;
    keys.add(e.code);
    if (e.code.startsWith('Arrow')) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  // ---------------------------------------------------------------- drawing

  function drawHud() {
    const v = getVehicle();
    const c = $('#hud');
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    const att = v?.state.att;
    const roll = att?.roll ?? 0;
    const pitch = att?.pitch ?? 0;
    g.save();
    g.clearRect(0, 0, w, h);
    g.translate(w / 2, h / 2);
    g.rotate(-roll);
    const pxPerDeg = h / 60;
    const horizon = pitch * DEG * pxPerDeg;
    g.fillStyle = '#1e5a8a';
    g.fillRect(-w, -h * 2 + horizon, w * 2, h * 2);
    g.fillStyle = '#6b4a2b';
    g.fillRect(-w, horizon, w * 2, h * 2);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-w, horizon);
    g.lineTo(w, horizon);
    g.stroke();
    g.font = '11px sans-serif';
    g.fillStyle = '#fff';
    for (let d = -30; d <= 30; d += 10) {
      if (!d) continue;
      const y = horizon - d * pxPerDeg;
      g.beginPath();
      g.moveTo(-30, y);
      g.lineTo(30, y);
      g.stroke();
      g.fillText(String(d), 34, y + 4);
    }
    g.restore();
    // aircraft symbol
    g.strokeStyle = '#fbbf24';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(w / 2 - 60, h / 2);
    g.lineTo(w / 2 - 15, h / 2);
    g.lineTo(w / 2, h / 2 + 10);
    g.lineTo(w / 2 + 15, h / 2);
    g.lineTo(w / 2 + 60, h / 2);
    g.stroke();
    // readouts
    const hud = v?.state.hud;
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, w, 24);
    g.fillRect(0, h - 24, w, 24);
    g.fillStyle = '#fff';
    g.font = '13px sans-serif';
    g.fillText(`${v?.state.mode || ''} ${v?.state.armed ? 'ARMED' : 'disarmed'}`, 8, 16);
    if (hud) {
      g.fillText(`AS ${hud.airspeed.toFixed(1)} m/s  GS ${hud.groundspeed.toFixed(1)}  ALT ${(v.state.pos?.relAlt ?? hud.alt).toFixed(1)} m  VS ${hud.climb.toFixed(1)}  THR ${hud.throttle}%  HDG ${hud.heading}°`, 8, h - 8);
    }
  }

  function drawGraph() {
    const c = $('#tuneGraph');
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    const now = Date.now();
    const panels = [['roll', 'navRoll', 'Roll'], ['pitch', 'navPitch', 'Pitch']];
    const ph = h / panels.length;
    panels.forEach(([actual, desired, label], i) => {
      const y0 = i * ph;
      const maxDeg = 45;
      const yOf = (deg) => y0 + ph / 2 - (deg / maxDeg) * (ph / 2 - 6);
      const xOf = (t) => w - ((now - t) / 1000 / HISTORY_S) * w;
      g.strokeStyle = '#22304f';
      g.beginPath();
      g.moveTo(0, yOf(0));
      g.lineTo(w, yOf(0));
      g.stroke();
      for (const [key, color] of [[desired, '#8b5cf6'], [actual, '#22d3ee']]) {
        g.strokeStyle = color;
        g.lineWidth = 2;
        g.beginPath();
        let started = false;
        for (const p of history) {
          if (p[key] === undefined) continue;
          const x = xOf(p.t);
          const y = yOf(Math.max(-maxDeg, Math.min(maxDeg, p[key])));
          if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
        }
        g.stroke();
      }
      g.fillStyle = '#8a9bb8';
      g.font = '12px sans-serif';
      g.fillText(`${label}: actual (cyan) vs desired (violet), ±${maxDeg}°`, 6, y0 + 14);
    });
  }

  function drawMap() {
    const v = getVehicle();
    const c = $('#trackMap');
    const g = c.getContext('2d');
    const w = c.width;
    const h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#0b1222';
    g.fillRect(0, 0, w, h);
    const pos = v?.state.pos;
    if (!pos) {
      g.fillStyle = '#8a9bb8';
      g.fillText('Waiting for position…', 10, 20);
      return;
    }
    const centerLat = pos.lat;
    const centerLon = pos.lon;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(centerLat * Math.PI / 180);
    const span = Math.max(200, ...track.map((p) => Math.max(Math.abs(p.lat - centerLat) * mPerDegLat, Math.abs(p.lon - centerLon) * mPerDegLon) * 2.4));
    const scale = Math.min(w, h) / span;
    const xy = (lat, lon) => [w / 2 + (lon - centerLon) * mPerDegLon * scale, h / 2 - (lat - centerLat) * mPerDegLat * scale];
    // grid every 100 m (or 500 m when zoomed out)
    const step = span > 2000 ? 500 : 100;
    g.strokeStyle = '#162038';
    for (let m = -Math.ceil(span / step) * step; m <= span; m += step) {
      g.beginPath(); g.moveTo(w / 2 + m * scale, 0); g.lineTo(w / 2 + m * scale, h); g.stroke();
      g.beginPath(); g.moveTo(0, h / 2 + m * scale); g.lineTo(w, h / 2 + m * scale); g.stroke();
    }
    g.strokeStyle = '#22d3ee';
    g.lineWidth = 2;
    g.beginPath();
    track.forEach((p, i) => {
      const [x, y] = xy(p.lat, p.lon);
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
    if (v.state.home) {
      const [hx, hy] = xy(v.state.home.lat, v.state.home.lon);
      g.fillStyle = '#34d399';
      g.fillText('H', hx - 4, hy + 4);
    }
    const hdg = ((pos.hdg ?? v.state.hud?.heading ?? 0) * Math.PI) / 180;
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate(hdg);
    g.fillStyle = '#fbbf24';
    g.beginPath();
    g.moveTo(0, -12); g.lineTo(8, 10); g.lineTo(0, 5); g.lineTo(-8, 10); g.closePath();
    g.fill();
    g.restore();
    g.fillStyle = '#8a9bb8';
    g.fillText(`grid ${step} m · ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}`, 8, h - 8);
  }

  function frame() {
    if (!active) return;
    drawHud();
    drawGraph();
    drawMap();
    raf = requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- data

  function onAtt(e) {
    const v = getVehicle();
    const nav = v?.state.nav;
    history.push({ t: e.detail.t, roll: e.detail.roll * DEG, pitch: e.detail.pitch * DEG, navRoll: nav?.roll, navPitch: nav?.pitch });
    while (history.length && Date.now() - history[0].t > HISTORY_S * 1000) history.shift();
  }

  function onPos(e) {
    const last = track[track.length - 1];
    if (!last || Math.abs(last.lat - e.detail.lat) + Math.abs(last.lon - e.detail.lon) > 2e-6) track.push({ lat: e.detail.lat, lon: e.detail.lon });
    if (track.length > 3000) track.shift();
  }

  return {
    attach(v) {
      history.length = 0;
      track.length = 0;
      v.addEventListener('att', onAtt);
      v.addEventListener('pos', onPos);
      v.addEventListener('state', () => {
        if (!active) return;
        $('#armBtn').textContent = v.state.armed ? 'Disarm' : 'Arm';
        $('#armBtn').classList.toggle('danger', v.state.armed);
      });
    },
    show(on) {
      const v = getVehicle();
      active = on;
      if (!v) return;
      v.requestFlightStreams(on);
      if (on) {
        renderControls();
        $('#armBtn').textContent = v.state.armed ? 'Disarm' : 'Arm';
        raf = requestAnimationFrame(frame);
        sticksTimer = setInterval(sendSticks, 50);
      } else {
        cancelAnimationFrame(raf);
        clearInterval(sticksTimer);
        if ($('#stickSource').value !== 'off' && v.isSitl) v.rcOverride(new Array(18).fill(0)); // hand control back
      }
    },
  };
}
