# Waterloo EV Scouting

Local-network scouting app for the Waterloo EV Challenge (Team 839). Scouts on phones tap a button each time a team crosses start/finish; the server computes lap time and average speed (700 m track length, 50-lap target over the 70 min event). Our Pi pushes live ground speed over WebSocket.

**Race-day setup:** see [`RACE_DAY.md`](RACE_DAY.md) for the one-script boot. TL;DR — `./run.sh` (mac/linux) or `run.bat` (windows), then point phones at the LAN URL the banner prints.

## On the laptop (server)

```powershell
cd "C:\Users\danie\Code Projects\waterloo-ev-scouting"
pip install -r requirements.txt
python app.py
```

The server binds to `0.0.0.0:5000`. Find the laptop's IP:

```powershell
ipconfig | findstr IPv4
```

Open on the laptop / share with scouts:
- Dashboard:  `http://<laptop-ip>:5000/`
- Scout view: `http://<laptop-ip>:5000/scout`
- Our speed:  `http://<laptop-ip>:5000/self`

**Firewall:** the first time you run it, Windows will ask to allow Python through the firewall — pick **Private networks** so phones on the same WiFi/hotspot can reach it.

## On the Raspberry Pi

```bash
pip install "python-socketio[client]"
```

Edit `pi_client.py`:
1. `SERVER_URL` = laptop's IP + `:5000`
2. `WHEEL_DIAMETER_M` and `GEAR_RATIO` for your drivetrain
3. While testing without Phoenix 6 hooked up, leave `USE_FAKE_DATA = True` — the dashboard will show a varying fake speed so you can verify everything works end-to-end. Flip to `False` and uncomment the Phoenix 6 block in `read_motor_real()` when ready.

Run:
```bash
python pi_client.py
```

## Race log (LoRa live telemetry)

The `/race-log` page is a pit-side live dashboard for the LoRa receiver. It reads
newline-delimited JSON packets directly from a USB LoRa receiver via the browser's
**Web Serial API** (Chrome / Edge only — Safari has no Web Serial).

Open from the laptop:
```
http://<laptop-ip>:5000/race-log
```

What it does:
- **Live LoRa** — connect a USB LoRa receiver and see speed / bus V / supply A /
  temp / faults / ESC heartbeat / GPS lock at the cadence the Pi sends them (2 Hz).
- **Mock stream** — run the page without any hardware. Yellow `RUNNING (MOCK)` badge
  so you never confuse it with the live car.
- **Pi CSV import** — drop in `/home/pi/race_logs/race-*.csv` for the high-detail
  backup view + Live-vs-Backup comparison.
- **Replay** — load a saved Pi CSV and stream it back through the same parser at
  1× / 5× / 10× / 30×. Blue `REPLAY` badge.
- **Export JSON or CSV** — saved logs in the Pi-logger CSV column order, so existing
  Pi-side tooling can ingest both.
- **Race-day badges** — `LINK LOST` when the USB drops mid-race, `ESC SEEN/NOT SEEN`
  from the Pi's `drive_seen` field (distinguishes "battery emergency" from "motor
  not powered"), `PI WARN` mirror for the Pi's own warn flag, bus-V sparkline.

No server-side state — the page is fully client-side. Web Serial means the LoRa
receiver plugs into the laptop running the server, not the Pi.

## Scout workflow

1. Open `/scout` on the phone.
2. Tap the team you're tracking.
3. First **LAP** tap = starts the timer (no lap time yet — that's just the start line).
4. Every subsequent tap records a lap. Lap time + km/h appears immediately and on the dashboard.
5. "Undo Last Lap" fixes accidental taps.

One scout per team is the easiest setup. Multiple phones can scout different teams at once.

## Files

| File | Purpose |
| --- | --- |
| `app.py` | Flask + SocketIO server, all API routes |
| `schema.sql` | SQLite tables (teams, laps) |
| `templates/` | Dashboard, scout, self-telemetry pages |
| `static/style.css` | Dark theme, big tap targets for phones, race-log telemetry blocks |
| `static/race-log/` | Vanilla-JS modules for the LoRa page (parser, Web Serial, mock, replay) |
| `pi_client.py` | Runs on Pi, pushes speed via WebSocket |
| `scouting.db` | Auto-created on first run |

## Resetting between sessions

Stop the server, delete `scouting.db`, restart. Your custom teams will be lost — re-add them from the scout page.
