# Waterloo EV Scouting

Local-network scouting app for the Waterloo EV Challenge. Scouts on phones tap a button each time a team crosses start/finish; the server computes lap time and average speed (1 km track length). Our Pi pushes live ground speed over WebSocket.

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
| `static/style.css` | Dark theme, big tap targets for phones |
| `pi_client.py` | Runs on Pi, pushes speed via WebSocket |
| `scouting.db` | Auto-created on first run |

## Resetting between sessions

Stop the server, delete `scouting.db`, restart. Your custom teams will be lost — re-add them from the scout page.
