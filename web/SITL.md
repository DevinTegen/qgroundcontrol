# Test-fly in the simulator (SITL)

The simulator runs **real ArduPilot code** (ArduPlane / ArduCopter 4.6.3) with ArduPilot's built-in flight physics,
so parameter changes behave the way they would on your aircraft.

## Option 1: in your browser, nothing to install (GitHub Codespaces)

1. On GitHub, open this repository, switch to the `feat/params-rc-claude` branch, then click
   **Code → Codespaces → ⋯ → New with options…**, pick the **AIGC SITL** configuration, and create it.
2. The first start builds ArduPilot (about 10 minutes, once per codespace). When the terminal says
   *"AIGC Web: open … and press Connect"*, a browser tab opens on the forwarded port. If it doesn't, open the
   **Ports** tab and click the globe next to **AIGC Web + SITL**.
3. Press **Connect**. The page detects the simulator automatically.

To fly a different airframe, stop it with Ctrl+C in the terminal and run one of:

```bash
tools/aigc/run_sitl.sh plane        # conventional plane (default)
tools/aigc/run_sitl.sh wing         # flying wing / elevons (Chupito, Manta style)
tools/aigc/run_sitl.sh quadplane    # VTOL quadplane
tools/aigc/run_sitl.sh tailsitter   # VTOL tailsitter (Lucid style)
tools/aigc/run_sitl.sh copter       # quad X
```

Add `--wipe` to reset all parameters, or `--home LAT,LON,ALT_M,HEADING` to start somewhere else.

Codespaces is billed to your GitHub account. Personal accounts include free monthly hours. Stop the codespace when
you're done.

## Option 2: on your own computer (macOS or Linux)

```bash
git clone -b feat/params-rc-claude https://github.com/DevinTegen/qgroundcontrol aigc
cd aigc
tools/aigc/run_sitl.sh plane
```

Then open http://127.0.0.1:5761/. On macOS you need the Xcode command line tools (`xcode-select --install`). The
first run builds ArduPilot. Desktop AIGC, QGroundControl or Mission Planner can connect at the same time over TCP
`127.0.0.1:5762`.

## Flying

- **Fly tab:** attitude display, track map, mode buttons, **Arm**.
- **Sticks** (simulator only): pick **USB joystick / radio** and set your TX15 to *USB Joystick (HID)* when you plug
  it in. Use the axis boxes to map roll/pitch/throttle/yaw; the live axis numbers show which is which. Or pick
  **Keyboard**: arrows for roll/pitch, A/D for yaw, W/S for throttle.
- **Plane takeoff:** set FBWA, arm, throttle up, pull back gently. Or use the TAKEOFF mode button after arming.
- **Copter takeoff:** set ALT_HOLD or LOITER, arm, raise throttle above mid-stick.

## Tuning loop

1. Fly in a stabilized mode (FBWA, or a Q-mode / LOITER for VTOL and copter).
2. On the **Parameters** tab, change a gain (for example `PTCH_RATE_P`, `RLL_RATE_P`, `PTCH_RATE_D`) and write it.
   In the simulator, writes are allowed while armed.
3. Back on **Fly**, watch the **tuning graph**: violet is what the autopilot wants, cyan is what the aircraft does.
   Overshoot or oscillation means too much gain; a slow, lagging cyan line means too little.
4. **Ask Claude** works here too: copy the setup, describe what you see, paste the suggestions back, review, and
   write.

Simulated physics are a generic model, not your exact airframe, so use the simulator to learn what each parameter does
and to rehearse changes. Do the final tuning on the real aircraft.
