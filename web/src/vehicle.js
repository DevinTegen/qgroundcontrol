// Vehicle connection: heartbeats, identity, telemetry, parameter download (MAVLink FTP with defaults, or
// PARAM_REQUEST_LIST fallback) and confirmed parameter writes.
import { MavlinkEncoder, MavlinkParser, MAV_PARAM_TYPE, MAV_TYPE_GCS } from './mavlink.js';

const MAV_CMD_REQUEST_MESSAGE = 512;
const MAV_CMD_SET_MESSAGE_INTERVAL = 511;
const MSG_ID_AUTOPILOT_VERSION = 148;
const MSG_ID_RC_CHANNELS = 65;
const MAV_MODE_FLAG_SAFETY_ARMED = 128;
const MAV_AUTOPILOT_INVALID = 8;

const PLANE_MODES = { 0: 'MANUAL', 1: 'CIRCLE', 2: 'STABILIZE', 3: 'TRAINING', 4: 'ACRO', 5: 'FBWA', 6: 'FBWB', 7: 'CRUISE', 8: 'AUTOTUNE', 10: 'AUTO', 11: 'RTL', 12: 'LOITER', 13: 'TAKEOFF', 14: 'AVOID_ADSB', 15: 'GUIDED', 17: 'QSTABILIZE', 18: 'QHOVER', 19: 'QLOITER', 20: 'QLAND', 21: 'QRTL', 22: 'QAUTOTUNE', 23: 'QACRO', 24: 'THERMAL', 25: 'LOITER_ALT_QLAND', 26: 'AUTOLAND' };
const COPTER_MODES = { 0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE', 18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL', 22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID', 26: 'AUTOROTATE', 27: 'AUTO_RTL', 28: 'TURTLE' };
const ROVER_MODES = { 0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE', 8: 'DOCK', 9: 'CIRCLE', 10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED' };

/// ArduPilot docs set name for a MAV_TYPE.
export const MODES = { Plane: PLANE_MODES, Copter: COPTER_MODES, Rover: ROVER_MODES };

export function vehicleDocsName(mavType) {
  if ([1, 16, 19, 20, 21, 22, 23, 24, 25].includes(mavType)) return 'Plane';
  if ([2, 3, 4, 13, 14, 15, 29, 35].includes(mavType)) return 'Copter';
  if ([10, 11].includes(mavType)) return 'Rover';
  if (mavType === 12) return 'Sub';
  return 'Plane';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Vehicle extends EventTarget {
  constructor(transport) {
    super();
    this.transport = transport;
    this.encoder = new MavlinkEncoder(255, 190);
    this.parser = new MavlinkParser((m) => this._handle(m));
    this.target = null; // {sysid, compid}
    this.state = { armed: false, mode: '', type: null, docsName: null, version: null, versionType: null, battery: null, rssi: null, statustext: [],
      att: null, hud: null, pos: null, nav: null, home: null };
    this.params = new Map(); // name -> {value, type, def, index}
    this.paramCount = 0;
    this.rc = [];
    this._waiters = new Set();
    transport.onData = (bytes) => this.parser.push(bytes);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async start() {
    this._heartbeatTimer = setInterval(() => this._sendHeartbeat(), 1000);
    this._sendHeartbeat();
    const hb = await this.waitFor((m) => m.name === 'HEARTBEAT' && m.fields.autopilot !== MAV_AUTOPILOT_INVALID && m.fields.type !== MAV_TYPE_GCS, 8000);
    if (!hb) {
      throw new Error('No vehicle heartbeat. Check the link is in MAVLink mode and the baud rate matches.');
    }
    this.target = { sysid: hb.sysid, compid: hb.compid };
    this._emit('connected', this.target);

    // Identity: exact firmware version decides which parameter docs to load.
    for (let attempt = 0; attempt < 3 && !this.state.version; attempt++) {
      this.command(MAV_CMD_REQUEST_MESSAGE, [MSG_ID_AUTOPILOT_VERSION]);
      await this.waitFor((m) => m.name === 'AUTOPILOT_VERSION', 2000);
    }
    this.command(MAV_CMD_SET_MESSAGE_INTERVAL, [MSG_ID_RC_CHANNELS, 200000]);
  }

  stop() {
    clearInterval(this._heartbeatTimer);
  }

  async send(name, fields) {
    await this.transport.send(this.encoder.encode(name, fields));
  }

  _sendHeartbeat() {
    this.send('HEARTBEAT', { type: MAV_TYPE_GCS, autopilot: MAV_AUTOPILOT_INVALID, base_mode: 0, custom_mode: 0, system_status: 4, mavlink_version: 3 });
  }

  command(command, params = []) {
    const p = [...params, 0, 0, 0, 0, 0, 0, 0];
    return this.send('COMMAND_LONG', {
      target_system: this.target.sysid, target_component: this.target.compid, command, confirmation: 0,
      param1: p[0], param2: p[1], param3: p[2], param4: p[3], param5: p[4], param6: p[5], param7: p[6],
    });
  }

  /// Resolves with the first message matching predicate, or null after timeoutMs.
  waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve };
      this._waiters.add(waiter);
      setTimeout(() => {
        if (this._waiters.delete(waiter)) resolve(null);
      }, timeoutMs);
    });
  }

  _handle(m) {
    for (const waiter of [...this._waiters]) {
      if (waiter.predicate(m)) {
        this._waiters.delete(waiter);
        waiter.resolve(m);
      }
    }
    if (this.target && m.sysid !== this.target.sysid) {
      return;
    }
    const f = m.fields;
    switch (m.name) {
      case 'HEARTBEAT': {
        if (f.type === MAV_TYPE_GCS || f.autopilot === MAV_AUTOPILOT_INVALID) break;
        this.state.type = f.type;
        this.state.docsName = vehicleDocsName(f.type);
        this.state.armed = (f.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) !== 0;
        const table = this.state.docsName === 'Copter' ? COPTER_MODES : this.state.docsName === 'Rover' ? ROVER_MODES : PLANE_MODES;
        this.state.mode = table[f.custom_mode] ?? `Mode ${f.custom_mode}`;
        this._lastHeartbeat = Date.now();
        this._emit('state', this.state);
        break;
      }
      case 'AUTOPILOT_VERSION': {
        const v = f.flight_sw_version;
        this.state.version = `${(v >> 24) & 0xff}.${(v >> 16) & 0xff}.${(v >> 8) & 0xff}`;
        this.state.versionType = v & 0xff; // 255 = official release
        this._emit('state', this.state);
        break;
      }
      case 'SYS_STATUS':
        this.state.battery = f.voltage_battery > 0 ? f.voltage_battery / 1000 : null;
        this._emit('state', this.state);
        break;
      case 'RADIO_STATUS':
        this.state.rssi = f.rssi;
        break;
      case 'STATUSTEXT':
        this.state.statustext.unshift({ t: new Date(), severity: f.severity, text: f.text });
        this.state.statustext.length = Math.min(this.state.statustext.length, 200);
        this._emit('statustext', f);
        break;
      case 'RC_CHANNELS': {
        const n = f.chancount || 18;
        this.rc = Array.from({ length: Math.min(n, 18) }, (_, i) => f[`chan${i + 1}_raw`]);
        this._emit('rc', this.rc);
        break;
      }
      case 'PARAM_VALUE':
        this._onParamValue(f);
        break;
      case 'ATTITUDE':
        this.state.att = { roll: f.roll, pitch: f.pitch, yaw: f.yaw, t: Date.now() };
        this._emit('att', this.state.att);
        break;
      case 'VFR_HUD':
        this.state.hud = { airspeed: f.airspeed, groundspeed: f.groundspeed, alt: f.alt, climb: f.climb, throttle: f.throttle, heading: f.heading };
        this._emit('hud', this.state.hud);
        break;
      case 'GLOBAL_POSITION_INT':
        this.state.pos = { lat: f.lat / 1e7, lon: f.lon / 1e7, relAlt: f.relative_alt / 1000, hdg: f.hdg === 65535 ? null : f.hdg / 100 };
        this._emit('pos', this.state.pos);
        break;
      case 'NAV_CONTROLLER_OUTPUT':
        this.state.nav = { roll: f.nav_roll, pitch: f.nav_pitch, t: Date.now() };
        this._emit('nav', this.state.nav);
        break;
      case 'HOME_POSITION':
        this.state.home = { lat: f.latitude / 1e7, lon: f.longitude / 1e7 };
        break;
      default:
        break;
    }
  }

  /// ArduPilot SITL exposes its simulator parameters (SIM_*).
  get isSitl() {
    return this.params.has('SIM_SPEEDUP') || this.params.has('SIM_RATE_HZ');
  }

  /// Sends a COMMAND_LONG and resolves with the COMMAND_ACK result (0 = accepted), or null on timeout.
  async commandAck(command, params = [], timeoutMs = 3000) {
    const ack = this.waitFor((m) => m.name === 'COMMAND_ACK' && m.fields.command === command, timeoutMs);
    await this.command(command, params);
    const m = await ack;
    return m ? m.fields.result : null;
  }

  /// Telemetry for the Fly tab. Only requested while it is open, to keep slow radio links free.
  requestFlightStreams(on) {
    const rates = { 30: 100000, 74: 200000, 33: 200000, 62: 100000, 1: 1000000 };
    for (const [msgId, us] of Object.entries(rates)) {
      this.command(MAV_CMD_SET_MESSAGE_INTERVAL, [Number(msgId), on ? us : 0]);
    }
    if (on) this.command(MAV_CMD_REQUEST_MESSAGE, [242]); // HOME_POSITION
  }

  arm(arm) {
    return this.commandAck(400, [arm ? 1 : 0]);
  }

  setMode(customMode) {
    return this.commandAck(176, [1, customMode]);
  }

  /// RC override, channels 1..n as PWM (0 releases the channel back to the radio).
  rcOverride(pwm) {
    const f = { target_system: this.target.sysid, target_component: this.target.compid };
    for (let i = 0; i < 18; i++) f[`chan${i + 1}_raw`] = pwm[i] || 0;
    return this.send('RC_CHANNELS_OVERRIDE', f);
  }

  get linkAlive() {
    return this._lastHeartbeat && Date.now() - this._lastHeartbeat < 4000;
  }

  // ---------------------------------------------------------------- parameters

  _onParamValue(f) {
    const existing = this.params.get(f.param_id);
    this.params.set(f.param_id, { value: f.param_value, type: f.param_type, def: existing?.def, index: f.param_index });
    if (f.param_count && f.param_count !== 65535) {
      this.paramCount = f.param_count;
    }
    this._emit('param', { name: f.param_id, value: f.param_value });
  }

  /// Downloads all parameters. Tries MAVLink FTP first (fast, includes defaults), then PARAM_REQUEST_LIST.
  async downloadParams(onProgress = () => {}) {
    this.params.clear();
    try {
      const ok = await this._downloadParamsFtp(onProgress);
      if (ok) {
        this.paramSource = 'ftp';
        return;
      }
    } catch (e) {
      console.warn('FTP parameter download failed, falling back', e);
    }
    this.paramSource = 'list';
    await this._downloadParamsList(onProgress);
  }

  async _downloadParamsList(onProgress) {
    this.paramCount = 0;
    await this.send('PARAM_REQUEST_LIST', { target_system: this.target.sysid, target_component: this.target.compid });
    let lastCount = -1;
    let idle = 0;
    while (idle < 3) {
      await sleep(1000);
      onProgress(this.params.size, this.paramCount);
      if (this.paramCount && this.params.size >= this.paramCount) break;
      if (this.params.size === lastCount) idle++; else idle = 0;
      lastCount = this.params.size;
    }
    // Re-request anything that was dropped by the radio link.
    for (let pass = 0; pass < 5 && this.paramCount && this.params.size < this.paramCount; pass++) {
      const have = new Set([...this.params.values()].map((p) => p.index));
      const missing = [];
      for (let i = 0; i < this.paramCount; i++) if (!have.has(i)) missing.push(i);
      for (const index of missing) {
        await this.send('PARAM_REQUEST_READ', { target_system: this.target.sysid, target_component: this.target.compid, param_id: '', param_index: index });
        await sleep(30);
      }
      await sleep(1500);
      onProgress(this.params.size, this.paramCount);
    }
  }

  async _ftp(opcode, { session = 0, size = 0, offset = 0, data = [] } = {}, timeoutMs = 1500) {
    this._ftpSeq = ((this._ftpSeq || 0) + 1) & 0xffff;
    const seq = this._ftpSeq;
    const payload = new Uint8Array(251);
    const view = new DataView(payload.buffer);
    view.setUint16(0, seq, true);
    payload[2] = session;
    payload[3] = opcode;
    payload[4] = size;
    view.setUint32(8, offset, true);
    payload.set(data, 12);
    for (let attempt = 0; attempt < 4; attempt++) {
      // Replies carry seq + 1 of the request (NAKs don't echo the offset).
      const reply = this.waitFor((m) => m.name === 'FILE_TRANSFER_PROTOCOL' && m.fields.payload[5] === opcode &&
        (m.fields.payload[0] | (m.fields.payload[1] << 8)) === ((seq + 1) & 0xffff), timeoutMs);
      await this.send('FILE_TRANSFER_PROTOCOL', { target_network: 0, target_system: this.target.sysid, target_component: this.target.compid, payload: Array.from(payload) });
      const m = await reply;
      if (m) {
        const p = new Uint8Array(m.fields.payload);
        return { opcode: p[3], session: p[2], size: p[4], data: p.slice(12, 12 + p[4]) };
      }
    }
    return null;
  }

  async _downloadParamsFtp(onProgress) {
    const OPEN_RO = 4, READ = 5, TERMINATE = 1, RESET = 2, ACK = 128;
    await this._ftp(RESET, {}, 800);
    const path = new TextEncoder().encode('@PARAM/param.pck?withdefaults=1');
    const open = await this._ftp(OPEN_RO, { size: path.length, data: path }, 2000);
    if (!open || open.opcode !== ACK || open.size < 4) {
      return false;
    }
    const session = open.session;
    // The size reported at open is an estimate for generated files like param.pck; read until EOF.
    const sizeEstimate = new DataView(open.data.buffer).getUint32(0, true);
    const NAK = 129, ERR_EOF = 6;
    const chunks = [];
    let offset = 0;
    for (;;) {
      const r = await this._ftp(READ, { session, size: 239, offset }, 1500);
      if (r && r.opcode === NAK && r.data[0] === ERR_EOF) {
        break;
      }
      if (!r || r.opcode !== ACK || r.size === 0) {
        await this._ftp(TERMINATE, { session }, 500);
        return false;
      }
      chunks.push(r.data);
      offset += r.size;
      onProgress(Math.min(offset, sizeEstimate), Math.max(offset, sizeEstimate), 'bytes');
    }
    await this._ftp(TERMINATE, { session }, 500);
    const file = new Uint8Array(offset);
    let pos = 0;
    for (const c of chunks) { file.set(c, pos); pos += c.length; }
    const parsed = parseParamPck(file);
    for (const [name, p] of parsed) this.params.set(name, p);
    this.paramCount = parsed.size;
    return parsed.size > 0;
  }

  /// Writes a parameter and resolves with the value the vehicle confirms. Refused while armed.
  async setParam(name, value) {
    if (this.state.armed && !this.isSitl) {
      throw new Error('Vehicle is armed');
    }
    const p = this.params.get(name);
    if (!p) {
      throw new Error(`${name} is not a parameter on this vehicle`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const echo = this.waitFor((m) => m.name === 'PARAM_VALUE' && m.fields.param_id === name, 1500);
      await this.send('PARAM_SET', { target_system: this.target.sysid, target_component: this.target.compid, param_id: name, param_value: Number(value), param_type: p.type });
      const m = await echo;
      if (m) {
        return m.fields.param_value;
      }
    }
    throw new Error(`No confirmation from the vehicle for ${name}`);
  }
}

/// Parses ArduPilot's @PARAM/param.pck (format 0x671B, or 0x671C with defaults).
export function parseParamPck(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map();
  const magic = view.getUint16(0, true);
  const numParams = view.getUint16(2, true);
  if (magic !== 0x671b && magic !== 0x671c) {
    throw new Error('Not a param.pck file');
  }
  const typeMap = { 1: MAV_PARAM_TYPE.INT8, 2: MAV_PARAM_TYPE.INT16, 3: MAV_PARAM_TYPE.INT32, 4: MAV_PARAM_TYPE.REAL32 };
  const sizes = { 1: 1, 2: 2, 3: 4, 4: 4 };
  const read = (ptype, at) => (ptype === 1 ? view.getInt8(at) : ptype === 2 ? view.getInt16(at, true) : ptype === 3 ? view.getInt32(at, true) : view.getFloat32(at, true));
  let pos = 6;
  let name = '';
  while (pos < bytes.length && out.size < numParams) {
    if (bytes[pos] === 0) { pos++; continue; } // padding
    const ptype = bytes[pos] & 0x0f;
    const withDefault = ((bytes[pos] >> 4) & 0x01) === 1;
    const nameLen = ((bytes[pos + 1] >> 4) & 0x0f) + 1;
    const commonLen = bytes[pos + 1] & 0x0f;
    pos += 2;
    if (!sizes[ptype] || nameLen + commonLen > 16) {
      throw new Error(`Corrupt param.pck at byte ${pos}`);
    }
    name = name.slice(0, commonLen) + new TextDecoder().decode(bytes.subarray(pos, pos + nameLen));
    pos += nameLen;
    const value = read(ptype, pos);
    pos += sizes[ptype];
    // In the with-defaults format a missing default means the value is the default.
    let def = magic === 0x671c ? value : undefined;
    if (withDefault) {
      def = read(ptype, pos);
      pos += sizes[ptype];
    }
    out.set(name, { value, type: typeMap[ptype], def, index: out.size });
  }
  return out;
}
