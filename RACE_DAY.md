# Race-day deploy

This is the venue-day "what to actually run" doc. Keep it next to the laptop.

## 1. Start the server

**macOS / Linux:**

```bash
cd waterloo-ev-scouting
./run.sh
```

**Windows:**

```cmd
cd waterloo-ev-scouting
run.bat
```

`run.sh` / `run.bat` will:

- create a Python venv if one doesn't exist
- install `requirements.txt`
- detect the laptop's LAN IP
- print URLs for both the laptop and phones
- bind Flask + Socket.IO to `0.0.0.0` on port `5050`

The banner that prints when it boots looks like this:

```
╔════════════════════════════════════════════════════════════════════╗
║  WLOO/EV · PIT TELEMETRY · race-day server                         ║
╠════════════════════════════════════════════════════════════════════╣
║  Local laptop:        http://localhost:5050/                       ║
║  Phones / pit crew:   http://10.1.1.118:5050/                      ║
╚════════════════════════════════════════════════════════════════════╝
```

Use whatever LAN IP it shows — that's the one phones get pointed at.

## 2. Firewall (first run only)

- **macOS** — the first time you run `python` you'll get a "do you want to allow incoming connections" prompt. Click **Allow**.
- **Windows** — same prompt from Windows Defender, pick **Private networks**.

If you skip past the prompt and phones can't reach the laptop:
- macOS → System Settings → Network → Firewall → Options → make sure Python isn't set to block incoming.
- Windows → Windows Defender Firewall → Allow an app → tick Python on Private.

## 3. Phones / laptop pages

Point each device at the URL the banner printed. Pages:

| URL | Who opens it | Purpose |
| --- | --- | --- |
| `/` | Laptop big screen | Live leaderboard + our-car readout |
| `/scout` | Spotter phones | Tap a team to record laps |
| `/race-log` | Laptop running Chrome / Edge | LoRa live race log + Pi CSV import + replay |
| `/self` | In-car phone | Big driver speed display |

**`/race-log` requires Chrome or Edge** on the device whose USB port the LoRa receiver is plugged into. Web Serial is not in Safari and not on phones — keep the LoRa USB in the laptop and load `/race-log` in Chrome there.

## 4. Pi side

Edit `pi_client.py` (Pi for our-car speed via Socket.IO):

```python
SERVER_URL = 'http://10.1.1.118:5050'   # use the LAN IP the banner printed, port 5050
```

For LoRa, the existing `lora_telemetry_tx.py` on the Pi (in `EV-CAR/pi-code/`) already writes newline-delimited JSON at 115200 baud to `/dev/ttyUSB0`. The pit-side Heltec mirrors it to laptop USB → that USB is what `/race-log` connects to via Web Serial.

## 5. Quick sanity checks before the green flag

- [ ] Banner shows a real LAN IP (not `<your-laptop-ip>`)
- [ ] One scout phone opens `/scout` over WiFi and can record a lap
- [ ] `/race-log` opens in Chrome, **START MOCK** produces samples, status reads `RUNNING (MOCK)`
- [ ] LoRa USB plugged in, **CONNECT LORA** picks the port, packets arrive
- [ ] `ESC SEEN` shows green when the car's drive ESC is awake — if it shows `ESC NOT SEEN` while bus V is 0, that's "motor not powered," not "battery dead"

## 6. Stopping

`Ctrl-C` in the terminal that's running `run.sh` / `run.bat`. The scouting DB (`scouting.db`) is left in place — laps you've recorded survive a restart. Reset it with:

```bash
rm scouting.db        # macOS / Linux
del scouting.db       # Windows
```

then restart the server.

## 7. Changing the port

If port 5050 is taken (or you want to use a different one) set `PORT` before launching:

```bash
PORT=5051 ./run.sh    # macOS / Linux
set PORT=5051 && run.bat   # Windows
```

The banner will reflect whatever you set.
