#!/usr/bin/env python3
"""Simulated ArduPlane for testing AIGC Web over WebSocket.

Serves MAVLink 2 on ws://127.0.0.1:<port>: heartbeats, AUTOPILOT_VERSION (4.6.3 official), RC_CHANNELS with a
switch that flips, STATUSTEXT, PARAM_* and MAVLink FTP @PARAM/param.pck?withdefaults=1.
Run with --no-ftp to exercise the PARAM_REQUEST_LIST fallback.
"""

import argparse
import asyncio
import json
import struct
import time

import websockets
from pymavlink.dialects.v20 import ardupilotmega as mavlink

AP_INT8, AP_INT16, AP_INT32, AP_FLOAT = 1, 2, 3, 4
MAV_TYPE = {AP_INT8: 2, AP_INT16: 4, AP_INT32: 6, AP_FLOAT: 9}

PARAMS = {
    # name: (ap_type, value, default)
    "RCMAP_ROLL": (AP_INT8, 1, 1), "RCMAP_PITCH": (AP_INT8, 2, 2), "RCMAP_THROTTLE": (AP_INT8, 3, 3), "RCMAP_YAW": (AP_INT8, 4, 4),
    "FLTMODE_CH": (AP_INT8, 8, 8), "PTCH_RATE_P": (AP_FLOAT, 1.2, 1.0), "RLL_RATE_P": (AP_FLOAT, 1.0, 1.0),
    "AIRSPEED_CRUISE": (AP_FLOAT, 18.0, 22.0), "SERVO_AUTO_TRIM": (AP_INT8, 1, 0), "STICK_MIXING": (AP_INT8, 1, 1),
    "ARMING_CHECK": (AP_INT32, 1, 1), "NEW_PARAM_X": (AP_INT8, 0, 0),
}
for ch in range(1, 17):
    PARAMS[f"RC{ch}_OPTION"] = (AP_INT16, 0, 0)
    PARAMS[f"RC{ch}_REVERSED"] = (AP_INT8, 0, 0)
    PARAMS[f"RC{ch}_MIN"] = (AP_INT16, 1000, 1100)
    PARAMS[f"RC{ch}_MAX"] = (AP_INT16, 2000, 1900)
    PARAMS[f"RC{ch}_TRIM"] = (AP_INT16, 1500, 1500)
PARAMS["RC7_OPTION"] = (AP_INT16, 4, 0)  # RTL switch


def param_pck(params: dict) -> bytes:
    names = sorted(params)
    out = bytearray(struct.pack("<HHH", 0x671C, len(names), len(names)))
    prev = ""
    fmt = {AP_INT8: "<b", AP_INT16: "<h", AP_INT32: "<i", AP_FLOAT: "<f"}
    for name in names:
        ptype, value, default = params[name]
        common = 0
        while common < min(len(prev), len(name), 15) and prev[common] == name[common]:
            common += 1
        rest = name[common:]
        with_default = value != default
        out.append(ptype | (0x10 if with_default else 0))
        out.append(((len(rest) - 1) << 4) | common)
        out += rest.encode()
        out += struct.pack(fmt[ptype], value)
        if with_default:
            out += struct.pack(fmt[ptype], default)
        prev = name
    return bytes(out)


class Sim:
    def __init__(self, ws, ftp: bool):
        self.ws = ws
        self.ftp = ftp
        self.mav = mavlink.MAVLink(None, srcSystem=1, srcComponent=1)
        self.params = {k: list(v) for k, v in PARAMS.items()}
        self.names = sorted(self.params)
        self.file = b""
        self.armed = False

    async def send(self, msg):
        await self.ws.send(msg.pack(self.mav))

    async def param_value(self, name):
        ptype, value, _ = self.params[name]
        await self.send(self.mav.param_value_encode(name.encode(), float(value), MAV_TYPE[ptype], len(self.names), self.names.index(name)))

    async def ftp_reply(self, req: bytes, opcode: int, data: bytes = b"", offset: int = 0, session: int = 0):
        seq = struct.unpack_from("<H", req, 0)[0]
        hdr = struct.pack("<HBBBBBBI", (seq + 1) & 0xFFFF, session, opcode, len(data), req[3], 0, 0, offset)
        payload = (hdr + data).ljust(251, b"\0")
        await self.send(self.mav.file_transfer_protocol_encode(0, 255, 190, list(payload)))

    async def handle(self, m):
        t = m.get_type()
        if t == "COMMAND_LONG" and int(m.command) == 512 and int(m.param1) == 148:
            await self.send(self.mav.autopilot_version_encode(0, (4 << 24) | (6 << 16) | (3 << 8) | 255, 0, 0, 0, b"\0" * 8, b"\0" * 8, b"\0" * 8, 0, 0, 0, b"\0" * 18))
        elif t == "PARAM_REQUEST_LIST":
            for name in self.names:
                await self.param_value(name)
                await asyncio.sleep(0.002)
        elif t == "PARAM_REQUEST_READ":
            name = m.param_id if m.param_index < 0 else self.names[m.param_index]
            if name in self.params:
                await self.param_value(name)
        elif t == "PARAM_SET":
            if m.param_id in self.params and not self.armed:
                self.params[m.param_id][1] = m.param_value if self.params[m.param_id][0] == AP_FLOAT else int(round(m.param_value))
                print("PARAM_SET", m.param_id, m.param_value, flush=True)
            await self.param_value(m.param_id)
        elif t == "FILE_TRANSFER_PROTOCOL":
            req = bytes(m.payload)
            opcode, size = req[3], req[4]
            offset = struct.unpack_from("<I", req, 8)[0]
            if not self.ftp:
                return  # behave like an old firmware: no FTP
            if opcode in (1, 2):
                await self.ftp_reply(req, 128)
            elif opcode == 4:
                path = req[12:12 + size].decode()
                self.file = param_pck(self.params) if path.startswith("@PARAM/param.pck") else b""
                await self.ftp_reply(req, 128, struct.pack("<I", len(self.file)))
            elif opcode == 5:
                chunk = self.file[offset:offset + min(size, 239)]
                if chunk:
                    await self.ftp_reply(req, 128, chunk, offset)
                else:
                    await self.ftp_reply(req, 129, bytes([6]), offset)

    async def telemetry(self):
        start = time.time()
        await self.send(self.mav.statustext_encode(6, b"ArduPlane V4.6.3 (sim)"))
        while True:
            base = 128 if self.armed else 0
            await self.send(self.mav.heartbeat_encode(1, 3, 81 | base, 5, 4))
            await self.send(self.mav.sys_status_encode(0, 0, 0, 500, 16120, -1, -1, 0, 0, 0, 0, 0, 0))
            for _ in range(5):
                t = time.time() - start
                ch6 = 2000 if int(t / 3) % 2 else 1000  # a switch that flips every 3 s
                chans = [1500, 1500, 1000, 1500, 1500, ch6, 1500, 1500] + [1500] * 10
                await self.send(self.mav.rc_channels_encode(int(t * 1000), 16, *chans, 200))
                await asyncio.sleep(0.2)


async def serve(ws, ftp):
    sim = Sim(ws, ftp)
    tel = asyncio.create_task(sim.telemetry())
    parser = mavlink.MAVLink(None)
    parser.robust_parsing = True
    try:
        async for data in ws:
            for m in parser.parse_buffer(data) or []:
                await sim.handle(m)
    finally:
        tel.cancel()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-ftp", action="store_true")
    args = ap.parse_args()
    async with websockets.serve(lambda ws: serve(ws, not args.no_ftp), "127.0.0.1", args.port):
        print(f"sim listening on ws://127.0.0.1:{args.port} ftp={not args.no_ftp}", flush=True)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
