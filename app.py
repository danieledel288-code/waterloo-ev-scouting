"""
Waterloo EV Challenge scouting server.

Run on a laptop at the venue. Scouts connect from phones on the same WiFi.
The Raspberry Pi runs pi_client.py and pushes our own speed over WebSocket.
"""
import os
import time
import sqlite3
from contextlib import closing
from flask import Flask, render_template, request, jsonify, g
from flask_socketio import SocketIO, emit

DB = os.path.join(os.path.dirname(__file__), 'scouting.db')
SCHEMA = os.path.join(os.path.dirname(__file__), 'schema.sql')
TRACK_LENGTH_M = 700    # Waterloo EV track length (meters)
TARGET_LAPS = 50        # Goal laps for the 70-minute event
OUR_TEAM_NAME = '839'

app = Flask(__name__)
app.config['SECRET_KEY'] = 'waterloo-ev-scouting'
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')


@app.context_processor
def inject_globals():
    return {
        'TRACK_LENGTH_M': TRACK_LENGTH_M,
        'TARGET_LAPS': TARGET_LAPS,
        'OUR_TEAM_NAME': OUR_TEAM_NAME,
    }


def db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_e=None):
    d = g.pop('db', None)
    if d:
        d.close()


def init_db():
    with closing(sqlite3.connect(DB)) as conn:
        with open(SCHEMA) as f:
            conn.executescript(f.read())
        conn.execute(
            "INSERT OR IGNORE INTO teams (id, name, color) VALUES (1, ?, '#faff00')",
            (OUR_TEAM_NAME,)
        )
        # If the seeded row still has an old name (from a previous run), rename it.
        conn.execute(
            "UPDATE teams SET name = ? WHERE id = 1 AND name IN ('Our Team', 'OUR TEAM')",
            (OUR_TEAM_NAME,)
        )
        conn.commit()


@app.route('/')
def dashboard():
    return render_template('dashboard.html')


@app.route('/scout')
def scout():
    teams = db().execute('SELECT * FROM teams ORDER BY name').fetchall()
    return render_template('scout.html', teams=teams)


@app.route('/self')
def self_view():
    return render_template('self.html')


@app.route('/race-log')
def race_log():
    """LoRa live race log — reads packets from a USB LoRa receiver via the
    browser's Web Serial API, displays live telemetry, imports Pi CSV backups,
    replays recorded sessions, exports JSON / CSV. No server-side state."""
    return render_template('race_log.html')


@app.route('/race-testing')
def race_testing():
    """Current-limit and battery test lab. Offline CSV comparison only: no motor
    commands are sent from this page."""
    return render_template('race_testing.html')


@app.route('/api/teams', methods=['GET', 'POST'])
def teams_api():
    conn = db()
    if request.method == 'POST':
        data = request.get_json()
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'error': 'name required'}), 400
        color = data.get('color') or '#3b82f6'
        try:
            conn.execute('INSERT INTO teams (name, color) VALUES (?, ?)', (name, color))
            conn.commit()
        except sqlite3.IntegrityError:
            return jsonify({'error': 'team already exists'}), 409
    rows = conn.execute('''
        SELECT t.id, t.name, t.color,
               (SELECT COUNT(*) FROM laps WHERE team_id=t.id AND lap_time_sec IS NOT NULL) AS lap_count,
               (SELECT lap_time_sec FROM laps WHERE team_id=t.id ORDER BY id DESC LIMIT 1) AS last_lap,
               (SELECT speed_kmh FROM laps WHERE team_id=t.id ORDER BY id DESC LIMIT 1) AS last_speed,
               (SELECT AVG(speed_kmh) FROM laps WHERE team_id=t.id) AS avg_speed,
               (SELECT MIN(lap_time_sec) FROM laps WHERE team_id=t.id) AS best_lap
        FROM teams t
        GROUP BY t.id
        ORDER BY lap_count DESC, t.name
    ''').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/teams/<int:team_id>', methods=['DELETE'])
def delete_team(team_id):
    if team_id == 1:
        return jsonify({'error': 'cannot delete our team'}), 400
    conn = db()
    conn.execute('DELETE FROM teams WHERE id = ?', (team_id,))
    conn.commit()
    return jsonify({'ok': True})


@app.route('/api/laps', methods=['POST'])
def add_lap():
    data = request.get_json()
    team_id = int(data['team_id'])
    conn = db()
    now = time.time()
    prev = conn.execute(
        'SELECT ts FROM laps WHERE team_id=? ORDER BY id DESC LIMIT 1', (team_id,)
    ).fetchone()
    if prev:
        lap_time = now - prev['ts']
        speed = (TRACK_LENGTH_M / lap_time) * 3.6
    else:
        # First tap establishes start line; no lap time yet.
        lap_time = None
        speed = None
    conn.execute(
        'INSERT INTO laps (team_id, ts, lap_time_sec, speed_kmh) VALUES (?, ?, ?, ?)',
        (team_id, now, lap_time, speed)
    )
    conn.commit()
    socketio.emit('lap_added', {
        'team_id': team_id, 'lap_time': lap_time, 'speed': speed
    })
    return jsonify({'lap_time': lap_time, 'speed': speed})


@app.route('/api/laps/<int:team_id>/undo', methods=['POST'])
def undo_lap(team_id):
    conn = db()
    row = conn.execute(
        'SELECT id FROM laps WHERE team_id=? ORDER BY id DESC LIMIT 1', (team_id,)
    ).fetchone()
    if row:
        conn.execute('DELETE FROM laps WHERE id = ?', (row['id'],))
        conn.commit()
        socketio.emit('lap_removed', {'team_id': team_id})
    return jsonify({'ok': True})


@app.route('/api/laps/<int:team_id>')
def list_laps(team_id):
    rows = db().execute(
        'SELECT id, ts, lap_time_sec, speed_kmh FROM laps WHERE team_id=? ORDER BY id', (team_id,)
    ).fetchall()
    return jsonify([dict(r) for r in rows])


# --- WebSocket: Pi pushes telemetry, browsers receive it ---

@socketio.on('our_speed')
def on_our_speed(data):
    # Re-broadcast to every connected browser.
    emit('our_speed', data, broadcast=True)


@socketio.on('connect')
def on_connect():
    print(f'client connected: {request.sid}')


if __name__ == '__main__':
    init_db()
    print(f'\n  Dashboard:  http://<your-laptop-ip>:5000/')
    print(f'  Scout:      http://<your-laptop-ip>:5000/scout')
    print(f'  Our speed:  http://<your-laptop-ip>:5000/self')
    print(f'  Race log:   http://<your-laptop-ip>:5000/race-log  (LoRa pit-side, Chrome only)\n')
    print(f'  Test lab:   http://<your-laptop-ip>:5000/race-testing  (CSV battery/current-limit analysis)\n')
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False, allow_unsafe_werkzeug=True)
