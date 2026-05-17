"""
Runs on the Raspberry Pi 4. Reads Kraken X60 velocity via CANivore / Phoenix 6,
converts motor RPS to ground speed, and pushes telemetry to the scouting server
over WebSocket every 200 ms.

Setup on Pi:
    pip install "python-socketio[client]" requests

When Phoenix 6 is wired up, also: pip install phoenix6
"""
import math
import time
import socketio

# ---- CONFIGURE THESE ----
SERVER_URL = 'http://192.168.1.100:5000'   # CHANGE: laptop's IP on venue WiFi
WHEEL_DIAMETER_M = 0.20                     # CHANGE: drive wheel diameter (meters)
GEAR_RATIO = 8.0                            # CHANGE: motor turns per wheel turn
USE_FAKE_DATA = True                        # set False once Phoenix 6 is wired up
UPDATE_HZ = 5                               # send rate (5 Hz = every 200 ms)
# -------------------------

sio = socketio.Client(reconnection=True, reconnection_delay=1, reconnection_delay_max=5)


def read_motor_real():
    """Real read via Phoenix 6. Uncomment and adapt once you've installed it."""
    # from phoenix6.hardware import TalonFX
    # global _motor
    # if '_motor' not in globals():
    #     _motor = TalonFX(0, 'canivore')  # device 0 on the CANivore bus
    # rps = _motor.get_velocity().value           # rotations per second
    # volt = _motor.get_supply_voltage().value    # volts
    # return rps, volt
    raise NotImplementedError("Set USE_FAKE_DATA = False AND uncomment the Phoenix 6 code above.")


def read_motor_fake():
    """Stub so you can test the website end-to-end before the Pi is hooked up."""
    t = time.time()
    rps = 60 + 15 * math.sin(t / 4)   # ~ varies between 45 and 75 motor RPS
    return rps, 12.6


def rps_to_kmh(motor_rps):
    wheel_rps = motor_rps / GEAR_RATIO
    m_per_s = wheel_rps * math.pi * WHEEL_DIAMETER_M
    return m_per_s * 3.6


@sio.event
def connect():
    print(f'[pi] connected to {SERVER_URL}')


@sio.event
def disconnect():
    print('[pi] disconnected')


def main():
    print(f'[pi] connecting to {SERVER_URL} (fake_data={USE_FAKE_DATA})')
    while True:
        try:
            sio.connect(SERVER_URL)
            break
        except Exception as e:
            print(f'[pi] connect failed: {e}; retry in 2s')
            time.sleep(2)

    period = 1.0 / UPDATE_HZ
    read = read_motor_fake if USE_FAKE_DATA else read_motor_real

    try:
        while True:
            t0 = time.time()
            try:
                rps, volt = read()
                speed = rps_to_kmh(rps)
                sio.emit('our_speed', {
                    'speed_kmh': speed,
                    'rpm': rps * 60,
                    'volt': volt,
                })
            except Exception as e:
                print(f'[pi] read error: {e}')
            # pace the loop
            elapsed = time.time() - t0
            if elapsed < period:
                time.sleep(period - elapsed)
    except KeyboardInterrupt:
        pass
    finally:
        sio.disconnect()


if __name__ == '__main__':
    main()
