#!/usr/bin/env python3
"""MAVLink <-> WebSocket bridge for AIGC Web.

Browsers can't open TCP/UDP sockets, so this relays raw MAVLink bytes between WebSocket clients and one upstream
link: ArduPilot SITL (tcp:127.0.0.1:5760), a UDP telemetry stream (udp:0.0.0.0:14550) or a serial port.

    python3 ws_bridge.py tcp:127.0.0.1:5760            # SITL
    python3 ws_bridge.py udp:0.0.0.0:14550             # ELRS backpack / mLRS bridge UDP on this computer
    python3 ws_bridge.py serial:/dev/ttyUSB0:115200    # needs pyserial

With --web <dir> it also serves the AIGC Web app, so http://<host>:5761/ opens the app and it connects to the
vehicle at ws://<host>:5761/mavlink on the same origin. That is how a radio module's Wi-Fi bridge and a cloud
SITL serve the app too. Otherwise open AIGC Web and connect to ws://127.0.0.1:5761 (browsers allow ws:// to
localhost even from https pages).
"""

import argparse
import asyncio
import json
import logging
import mimetypes
from http import HTTPStatus
from pathlib import Path

import websockets
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

log = logging.getLogger("aigc-bridge")


class Upstream:
    def __init__(self, spec: str):
        self.spec = spec
        self.clients: set = set()
        self.write = None

    async def broadcast(self, data: bytes):
        for ws in list(self.clients):
            try:
                await ws.send(data)
            except websockets.ConnectionClosed:
                self.clients.discard(ws)

    async def run(self):
        kind, _, rest = self.spec.partition(":")
        while True:
            try:
                if kind == "tcp":
                    host, port = rest.rsplit(":", 1)
                    await self._run_tcp(host, int(port))
                elif kind == "udp":
                    host, port = rest.rsplit(":", 1)
                    await self._run_udp(host, int(port))
                elif kind == "serial":
                    device, baud = rest.rsplit(":", 1)
                    await asyncio.to_thread(self._run_serial, device, int(baud), asyncio.get_running_loop())
                else:
                    raise SystemExit(f"Unknown upstream {self.spec!r}")
            except (OSError, ConnectionError) as e:
                log.warning("upstream %s: %s; retrying in 2 s", self.spec, e)
            self.write = None
            await asyncio.sleep(2)

    async def _run_tcp(self, host, port):
        reader, writer = await asyncio.open_connection(host, port)
        log.info("connected to tcp %s:%d", host, port)

        def write(data):
            writer.write(data)

        self.write = write
        while data := await reader.read(4096):
            await self.broadcast(data)
        raise ConnectionError("upstream closed")

    async def _run_udp(self, host, port):
        loop = asyncio.get_running_loop()
        peer = {}
        outer = self

        class Proto(asyncio.DatagramProtocol):
            def connection_made(self, transport):
                self.transport = transport

            def datagram_received(self, data, addr):
                peer["addr"] = addr  # reply to whoever is sending telemetry
                loop.create_task(outer.broadcast(data))

        transport, proto = await loop.create_datagram_endpoint(Proto, local_addr=(host, port))
        log.info("listening for udp on %s:%d", host, port)

        def write(data):
            if "addr" in peer:
                transport.sendto(data, peer["addr"])

        self.write = write
        await asyncio.Future()

    def _run_serial(self, device, baud, loop):
        import serial  # optional dependency

        with serial.Serial(device, baud, timeout=0.05) as port:
            log.info("opened serial %s @ %d", device, baud)
            self.write = port.write
            while True:
                data = port.read(4096)
                if data:
                    asyncio.run_coroutine_threadsafe(self.broadcast(data), loop)


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("upstream", nargs="?", default="tcp:127.0.0.1:5760")
    ap.add_argument("--listen", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=5761)
    ap.add_argument("--web", help="serve the AIGC Web app from this directory on the same port")
    ap.add_argument("--sitl", action="store_true", help="tell the app this is a simulator (enables the Simulator link)")
    ap.add_argument("--link", choices=["mlrs", "elrs", "direct"], help="preselect this link in the app")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    upstream = Upstream(args.upstream)

    async def handler(ws):
        upstream.clients.add(ws)
        log.info("browser connected (%d)", len(upstream.clients))
        try:
            async for data in ws:
                if upstream.write and isinstance(data, (bytes, bytearray)):
                    upstream.write(bytes(data))
        finally:
            upstream.clients.discard(ws)
            log.info("browser disconnected (%d)", len(upstream.clients))

    web_root = Path(args.web).resolve() if args.web else None

    def process_request(connection, request):
        # WebSocket upgrades go to the vehicle; plain GETs serve the app when --web is given.
        if request.headers.get("Upgrade", "").lower() == "websocket":
            return None
        if request.path.split("?", 1)[0] == "/aigc-bridge.json":
            info = json.dumps({"upstream": args.upstream, "sitl": args.sitl, "link": args.link})
            return Response(HTTPStatus.OK.value, "OK", Headers([("Content-Type", "application/json"), ("Cache-Control", "no-cache")]), info.encode())
        if not web_root:
            return connection.respond(HTTPStatus.NOT_FOUND, "AIGC bridge: connect with a WebSocket\n")
        rel = request.path.split("?", 1)[0].lstrip("/") or "index.html"
        target = (web_root / rel).resolve()
        if web_root not in target.parents and target != web_root or not target.is_file():
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix == ".js":
            ctype = "text/javascript"
        headers = Headers([("Content-Type", ctype), ("Content-Length", str(len(body))), ("Cache-Control", "no-cache")])
        return Response(HTTPStatus.OK.value, "OK", headers, body)

    async with serve(handler, args.listen, args.port, max_size=None, process_request=process_request):
        log.info("AIGC bridge: ws://%s:%d <-> %s", args.listen, args.port, args.upstream)
        await upstream.run()


if __name__ == "__main__":
    asyncio.run(main())
