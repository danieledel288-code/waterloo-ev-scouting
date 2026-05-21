#!/usr/bin/env bash
# Race-day boot script — macOS / Linux.
# Sets up venv if missing, installs deps, prints LAN URLs for phones,
# then runs the Flask server bound to all interfaces on $PORT (default 5050).
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-5050}"
VENV="${VENV:-.venv}"

# --- venv -------------------------------------------------------------------
if [ ! -d "$VENV" ]; then
  echo "[run] creating venv in $VENV"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

# --- deps -------------------------------------------------------------------
if [ ! -f "$VENV/.deps-installed" ] || [ requirements.txt -nt "$VENV/.deps-installed" ]; then
  echo "[run] installing requirements"
  pip install -q -r requirements.txt
  touch "$VENV/.deps-installed"
fi

# --- LAN IP -----------------------------------------------------------------
# Try a few interfaces, pick the first one with an address.
LAN_IP=""
for iface in en0 en1 en2 eth0 wlan0; do
  ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
  if [ -n "$ip" ]; then LAN_IP="$ip"; break; fi
done
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
[ -z "$LAN_IP" ] && LAN_IP="<your-laptop-ip>"

# --- banner -----------------------------------------------------------------
cat <<EOF

╔════════════════════════════════════════════════════════════════════╗
║  WLOO/EV · PIT TELEMETRY · race-day server                         ║
╠════════════════════════════════════════════════════════════════════╣
║  Local laptop:        http://localhost:${PORT}/                          ║
║  Phones / pit crew:   http://${LAN_IP}:${PORT}/                      ║
║                                                                    ║
║  Pages:                                                            ║
║    /            PIT WALL    (laptop big-screen)                    ║
║    /scout       SPOTTER     (phones)                               ║
║    /race-log    RACE LOG    (LoRa USB, Chrome only)                ║
║    /race-testing TEST LAB    (battery / current-limit analysis)    ║
║    /self        DRIVER      (in-car phone)                         ║
║                                                                    ║
║  Stop with Ctrl-C. Reset DB: rm scouting.db, restart.              ║
╚════════════════════════════════════════════════════════════════════╝

EOF

# --- run --------------------------------------------------------------------
exec env PORT="$PORT" python app.py
