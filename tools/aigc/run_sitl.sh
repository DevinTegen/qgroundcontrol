#!/usr/bin/env bash
# Run real ArduPilot SITL with the AIGC Web app in front of it.
#
#   tools/aigc/run_sitl.sh [plane|wing|quadplane|tailsitter|copter] [--home pendleton|cmac|LAT,LON,ALT,HDG] [--wipe] [--build-only]
#
# The aircraft starts at Pendleton, Oregon (KPDT, runway 25 threshold, facing west) unless --home says otherwise.
# First run downloads and builds ArduPilot (5-10 minutes); later runs start in seconds.
# Then open http://127.0.0.1:5761/ (or the forwarded port in a Codespace) and press Connect.
# Desktop AIGC/QGroundControl/Mission Planner can connect to tcp 127.0.0.1:5762 at the same time.
set -euo pipefail

VEHICLE="${1:-plane}"
shift || true
HOME_LOC="${AIGC_SITL_HOME:-pendleton}"
WIPE=""
BUILD_ONLY=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --home) HOME_LOC="$2"; shift 2 ;;
        --wipe) WIPE="-w"; shift ;;
        --build-only) BUILD_ONLY=1; shift ;;
        *) echo "Unknown option $1" >&2; exit 2 ;;
    esac
done

case "$HOME_LOC" in
    pendleton) HOME_LOC="45.69533,-118.82867,453,270" ;;  # KPDT runway 25 threshold
    cmac)      HOME_LOC="-35.363261,149.165230,584,353" ;; # ArduPilot's default field in Canberra
esac

PLANE_TAG="${AIGC_PLANE_TAG:-Plane-4.6.3}"
COPTER_TAG="${AIGC_COPTER_TAG:-Copter-4.6.3}"

case "$VEHICLE" in
    plane)      TAG=$PLANE_TAG;  TARGET=plane;  BIN=arduplane;  MODEL=plane;            DEFAULTS="Tools/autotest/models/plane.parm" ;;
    wing)       TAG=$PLANE_TAG;  TARGET=plane;  BIN=arduplane;  MODEL=plane-elevon;     DEFAULTS="Tools/autotest/models/plane.parm,Tools/autotest/default_params/plane-elevons.parm" ;;
    quadplane)  TAG=$PLANE_TAG;  TARGET=plane;  BIN=arduplane;  MODEL=quadplane;        DEFAULTS="Tools/autotest/default_params/quadplane.parm" ;;
    tailsitter) TAG=$PLANE_TAG;  TARGET=plane;  BIN=arduplane;  MODEL=plane-tailsitter; DEFAULTS="Tools/autotest/default_params/plane-tailsitter.parm" ;;
    copter)     TAG=$COPTER_TAG; TARGET=copter; BIN=arducopter; MODEL=X;                DEFAULTS="Tools/autotest/default_params/copter.parm" ;;
    *) echo "Vehicle must be plane, wing, quadplane, tailsitter or copter" >&2; exit 2 ;;
esac

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AIGC_HOME="${AIGC_HOME:-$HOME/.aigc}"
SRC="$AIGC_HOME/$TAG"
mkdir -p "$AIGC_HOME"

python_deps() {
    python3 -m pip install --quiet --user empy==3.3.4 pymavlink future pexpect dronecan websockets 2>/dev/null \
        || python3 -m pip install --quiet --break-system-packages empy==3.3.4 pymavlink future pexpect dronecan websockets
}

if [[ ! -x "$SRC/build/sitl/bin/$BIN" ]]; then
    echo "== Building ArduPilot $TAG SITL ($TARGET); first time takes a few minutes"
    if [[ "$(uname)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
        echo "Install the Xcode command line tools first: xcode-select --install" >&2
        exit 1
    fi
    python_deps
    if [[ ! -d "$SRC/.git" ]]; then
        git clone --depth 1 --branch "$TAG" https://github.com/ArduPilot/ardupilot.git "$SRC"
    fi
    (
        cd "$SRC"
        git submodule update --init --depth 1 modules/waf modules/mavlink
        git submodule update --init modules/DroneCAN/DSDL modules/DroneCAN/dronecan_dsdlc \
            modules/DroneCAN/pydronecan modules/DroneCAN/libcanard
        ./waf configure --board sitl
        ./waf "$TARGET"
    )
fi
[[ $BUILD_ONLY == 1 ]] && { echo "Built $SRC/build/sitl/bin/$BIN"; exit 0; }

python3 -c "import websockets" 2>/dev/null || python_deps

# Exact parameter docs for this version, served next to the app (falls back to ArduPilot's repository if offline).
VERSION="${TAG#*-}"
DOCS_VEHICLE="${TAG%%-*}"
if [[ ! -f "$REPO_DIR/web/docs/$DOCS_VEHICLE-$VERSION.json" ]]; then
    python3 "$REPO_DIR/tools/aigc/build_param_docs.py" "$REPO_DIR/web/docs" --only "$DOCS_VEHICLE-$VERSION" || true
fi

WORK="$AIGC_HOME/sitl-$VEHICLE"
mkdir -p "$WORK"
cd "$WORK"
DEFAULTS_ABS=$(echo "$DEFAULTS" | tr ',' '\n' | sed "s#^#$SRC/#" | paste -sd, -)
HOME_ARG=()
[[ -n "$HOME_LOC" ]] && HOME_ARG=(--home "$HOME_LOC")

echo "== Starting $BIN ($MODEL) from $TAG"
"$SRC/build/sitl/bin/$BIN" --model "$MODEL" --speedup 1 --defaults "$DEFAULTS_ABS" -I0 $WIPE "${HOME_ARG[@]}" \
    --serial1 tcp:5762 > "$WORK/sitl.log" 2>&1 &
SITL_PID=$!
trap 'kill $SITL_PID 2>/dev/null || true' EXIT INT TERM
sleep 2

echo "== AIGC Web: open http://127.0.0.1:5761/ and press Connect"
echo "   (other ground stations: tcp 127.0.0.1:5762)"
python3 "$REPO_DIR/tools/aigc/ws_bridge.py" tcp:127.0.0.1:5760 --web "$REPO_DIR/web" --sitl --port 5761
