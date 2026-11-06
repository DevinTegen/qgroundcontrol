# AIGC Web

Browser version of AIGC for ArduPilot: nothing to install. Live at
**https://devintegen.github.io/qgroundcontrol/** once GitHub Pages is enabled for this repository.

- **Connect:** choose **mLRS** (default) or **ELRS**, or USB straight to the flight controller.
  - USB uses Web Serial, so Chrome or Edge on a computer.
  - Wi-Fi uses a WebSocket served by the radio module's Wi-Fi chip, which needs the AIGC bridge firmware (in development).
    Browsers block unencrypted connections from https pages, so Wi-Fi works from the copy of this app that the module
    serves (`http://10.0.0.1` / `http://192.168.4.55`), not from GitHub Pages.
- **Parameters:** downloaded over MAVLink FTP with firmware defaults when available (ArduPilot 4.1+), otherwise via
  PARAM_REQUEST_LIST. Docs match the exact firmware version. CI mirrors ArduPilot's per-release `apm.pdef.xml` into
  `docs/`, and the app falls back to ArduPilot's ParameterRepository for the same major.minor.
- **Modified / Undocumented** filters, a details pane, Mission Planner `.param` export.
- **RC Mapping:** live channels, highlight on movement, assign axes / flight-mode channel (swaps instead of
  doubling up), `RCx_OPTION`, `RCx_REVERSED`.
- **Ask Claude:** copy your setup into a chat on your own Claude account, paste the reply back as
  `NAME = value  # reason` lines, then review before anything is written. Claude in Chrome can also read the page.
- Every write goes through a review dialog, is confirmed by the vehicle's `PARAM_VALUE` echo, and is refused while
  armed.

## Develop

```bash
cd web
python3 ../tools/aigc/build_param_docs.py docs --min-version 4.6   # optional: exact docs locally
python3 -m http.server 8080
python3 test/sim_vehicle.py            # simulated ArduPlane 4.6.3 on ws://127.0.0.1:8765
python3 test/e2e.py                    # headless Chrome end-to-end test
```

No build step: plain ES modules. `src/mavlink-defs.js` is generated from pymavlink's ardupilotmega dialect.
