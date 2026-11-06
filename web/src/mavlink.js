// Minimal MAVLink 1/2 codec for the messages in mavlink-defs.js.
import { MESSAGES } from './mavlink-defs.js';

const BY_ID = new Map(Object.entries(MESSAGES).map(([name, def]) => [def.id, { name, ...def }]));

const SIZES = { int8: 1, uint8: 1, char: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float: 4, int64: 8, uint64: 8, double: 8 };

function payloadLength(def) {
  return def.fields.reduce((n, [, type, len]) => n + SIZES[type] * (len || 1), 0);
}
for (const def of BY_ID.values()) {
  def.length = payloadLength(def);
}

function crcAccumulate(byte, crc) {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function crcCalculate(bytes, start, end, crcExtra) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc = crcAccumulate(bytes[i], crc);
  }
  return crcAccumulate(crcExtra, crc);
}

function readField(view, offset, type) {
  switch (type) {
    case 'int8': return view.getInt8(offset);
    case 'uint8': case 'char': return view.getUint8(offset);
    case 'int16': return view.getInt16(offset, true);
    case 'uint16': return view.getUint16(offset, true);
    case 'int32': return view.getInt32(offset, true);
    case 'uint32': return view.getUint32(offset, true);
    case 'float': return view.getFloat32(offset, true);
    case 'double': return view.getFloat64(offset, true);
    case 'int64': return view.getBigInt64(offset, true);
    case 'uint64': return view.getBigUint64(offset, true);
    default: throw new Error(`Unknown type ${type}`);
  }
}

function writeField(view, offset, type, value) {
  switch (type) {
    case 'int8': view.setInt8(offset, value); break;
    case 'uint8': case 'char': view.setUint8(offset, value); break;
    case 'int16': view.setInt16(offset, value, true); break;
    case 'uint16': view.setUint16(offset, value, true); break;
    case 'int32': view.setInt32(offset, value, true); break;
    case 'uint32': view.setUint32(offset, value, true); break;
    case 'float': view.setFloat32(offset, value, true); break;
    case 'double': view.setFloat64(offset, value, true); break;
    case 'int64': view.setBigInt64(offset, BigInt(value), true); break;
    case 'uint64': view.setBigUint64(offset, BigInt(value), true); break;
    default: throw new Error(`Unknown type ${type}`);
  }
}

export function decodePayload(def, payload) {
  // MAVLink 2 truncates trailing zero bytes; pad back to the full length.
  const full = new Uint8Array(def.length);
  full.set(payload.subarray(0, Math.min(payload.length, def.length)));
  const view = new DataView(full.buffer);
  const out = {};
  let offset = 0;
  for (const [name, type, len] of def.fields) {
    const size = SIZES[type];
    if (type === 'char' && len) {
      let s = '';
      for (let i = 0; i < len && full[offset + i] !== 0; i++) {
        s += String.fromCharCode(full[offset + i]);
      }
      out[name] = s;
    } else if (len) {
      out[name] = Array.from({ length: len }, (_, i) => readField(view, offset + i * size, type));
    } else {
      out[name] = readField(view, offset, type);
    }
    offset += size * (len || 1);
  }
  return out;
}

export function encodePayload(def, fields) {
  const buf = new Uint8Array(def.length);
  const view = new DataView(buf.buffer);
  let offset = 0;
  for (const [name, type, len] of def.fields) {
    const size = SIZES[type];
    const value = fields[name];
    if (type === 'char' && len) {
      const s = value || '';
      for (let i = 0; i < Math.min(len, s.length); i++) {
        buf[offset + i] = s.charCodeAt(i) & 0xff;
      }
    } else if (len) {
      const arr = value || [];
      for (let i = 0; i < Math.min(len, arr.length); i++) {
        writeField(view, offset + i * size, type, arr[i]);
      }
    } else if (value !== undefined) {
      writeField(view, offset, type, value);
    }
    offset += size * (len || 1);
  }
  return buf;
}

export class MavlinkEncoder {
  constructor(sysid = 255, compid = 190) {
    this.sysid = sysid;
    this.compid = compid;
    this.seq = 0;
  }

  encode(name, fields) {
    const def = MESSAGES[name];
    if (!def) {
      throw new Error(`Unknown message ${name}`);
    }
    let payload = encodePayload({ ...def, length: payloadLength(def) }, fields);
    let len = payload.length;
    while (len > 1 && payload[len - 1] === 0) {
      len--;
    }
    payload = payload.subarray(0, len);

    const frame = new Uint8Array(10 + len + 2);
    frame[0] = 0xfd;
    frame[1] = len;
    frame[2] = 0; // incompat flags
    frame[3] = 0; // compat flags
    frame[4] = this.seq;
    frame[5] = this.sysid;
    frame[6] = this.compid;
    frame[7] = def.id & 0xff;
    frame[8] = (def.id >> 8) & 0xff;
    frame[9] = (def.id >> 16) & 0xff;
    frame.set(payload, 10);
    const crc = crcCalculate(frame, 1, 10 + len, def.crc);
    frame[10 + len] = crc & 0xff;
    frame[11 + len] = crc >> 8;
    this.seq = (this.seq + 1) & 0xff;
    return frame;
  }
}

/// Stream parser: feed bytes, get decoded messages for known ids with valid CRC.
export class MavlinkParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buf = new Uint8Array(0);
    this.stats = { received: 0, crcErrors: 0, unknown: 0 };
  }

  push(bytes) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    let i = 0;
    while (i < merged.length) {
      const stx = merged[i];
      if (stx !== 0xfd && stx !== 0xfe) {
        i++;
        continue;
      }
      if (merged.length - i < 2) {
        break;
      }
      const len = merged[i + 1];
      const v2 = stx === 0xfd;
      const headerLen = v2 ? 10 : 6;
      const signed = v2 && merged.length - i > 2 && (merged[i + 2] & 0x01);
      const total = headerLen + len + 2 + (signed ? 13 : 0);
      if (merged.length - i < total) {
        break;
      }
      const msgid = v2 ? merged[i + 7] | (merged[i + 8] << 8) | (merged[i + 9] << 16) : merged[i + 5];
      const def = BY_ID.get(msgid);
      if (!def) {
        this.stats.unknown++;
        i += total; // can't verify; skip whole frame
        continue;
      }
      const crc = crcCalculate(merged, i + 1, i + headerLen + len, def.crc);
      const rxCrc = merged[i + headerLen + len] | (merged[i + headerLen + len + 1] << 8);
      if (crc !== rxCrc) {
        this.stats.crcErrors++;
        i++;
        continue;
      }
      const payload = merged.slice(i + headerLen, i + headerLen + len);
      const msg = {
        name: def.name,
        id: msgid,
        sysid: v2 ? merged[i + 5] : merged[i + 3],
        compid: v2 ? merged[i + 6] : merged[i + 4],
        fields: decodePayload(def, payload),
      };
      this.stats.received++;
      i += total;
      try {
        this.onMessage(msg);
      } catch (e) {
        console.error('MAVLink handler error', e);
      }
    }
    this.buf = merged.slice(i);
  }
}

export const MAV_PARAM_TYPE = { UINT8: 1, INT8: 2, UINT16: 3, INT16: 4, UINT32: 5, INT32: 6, REAL32: 9 };
export const MAV_AUTOPILOT_ARDUPILOTMEGA = 3;
export const MAV_TYPE_GCS = 6;
