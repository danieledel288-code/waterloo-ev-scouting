// Mock LoRa stream + CSV replay — both emit lines into the same parser pipeline
// as the real LoRa serial connection, so the rest of the page is source-agnostic.

import { parseCsvText, parseCsvRow, sampleToLoraLine } from './telemetry.js';

const round = (v, digits) => {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
};

/**
 * 2 Hz mock matching the deployed Pi packet shape (kph/busV/tempC/amps/seen/warn/...).
 * Returns a controller with .stop() and .isRunning().
 */
export function startMockStream({ onLine, durationS = 45, onEnd }) {
  const runId = new Date().toISOString();
  const startMs = Date.now();
  const startTs = startMs / 1000;
  let seq = 0;
  let stopped = false;
  let injectedFault = false;
  let injectedMalformed = false;
  let modeIdx = 0;
  const modes = ['DRIVE', 'DRIVE', 'COAST', 'REGEN', 'DRIVE'];

  onLine(JSON.stringify({
    type: 'run_start', run: runId, ts: startTs, seq: seq++, msg: 'Mock LoRa stream',
  }));

  const interval = setInterval(() => {
    if (stopped) return;
    const elapsed = (Date.now() - startMs) / 1000;

    if (elapsed >= durationS) {
      stopped = true;
      clearInterval(interval);
      onLine(JSON.stringify({ type: 'run_end', run: runId, ts: Date.now() / 1000, seq: seq++ }));
      if (onEnd) onEnd();
      return;
    }

    let kph;
    if (elapsed < 5) kph = (elapsed / 5) * 22;
    else if (elapsed < durationS - 8) {
      const t = elapsed - 5;
      kph = 22 + 10 * Math.sin(t / 3) + 4 * Math.sin(t * 1.7) + (Math.random() - 0.5) * 2;
    } else {
      const t = (durationS - elapsed) / 8;
      kph = Math.max(0, t * 25 + (Math.random() - 0.5) * 1.5);
    }
    kph = Math.max(0, kph);

    if (Math.random() < 0.05) modeIdx = (modeIdx + 1) % modes.length;
    const mode = modes[modeIdx];

    const thr = mode === 'DRIVE' ? Math.min(100, 30 + Math.random() * 50) : 0;
    const regen = mode === 'REGEN' ? Math.min(100, 20 + Math.random() * 40) : 0;
    const brk = mode === 'REGEN' ? Math.min(100, 10 + Math.random() * 20) : 0;
    const supply_a = mode === 'DRIVE'
      ? 18 + (thr / 100) * 38 + (Math.random() - 0.5) * 4
      : 2 + Math.random() * 2;
    const stator_a = supply_a * 1.8 + Math.random() * 5;
    const bus_v = 12.4 - (supply_a / 80) * 1.6 + (Math.random() - 0.5) * 0.1;
    const temp_c = Math.min(72, 32 + elapsed * 0.25 + (mode === 'DRIVE' ? Math.random() * 4 : 0));
    const gps_kph = Math.max(0, kph - 0.5 + (Math.random() - 0.5) * 1.5);

    let faults = [];
    if (!injectedFault && elapsed > durationS / 2 && elapsed < durationS / 2 + 0.6) {
      injectedFault = true;
      faults = ['OVER_TEMP_WARN'];
      onLine(JSON.stringify({
        type: 'fault', run: runId, ts: Date.now() / 1000, seq: seq++, faults,
      }));
    }
    if (!injectedMalformed && elapsed > 8) {
      injectedMalformed = true;
      onLine('{"type":"sample","kph":17.2,"mode":"DRIVE"');  // unterminated
    }
    if (seq > 5 && Math.random() < 0.03) seq += 1;  // occasionally skip a seq

    const warnFlag = (faults.length > 0 || temp_c >= 70 || bus_v < 9.5) ? 1 : 0;

    const pkt = {
      type: 'sample',
      run: runId, seq: seq++, ts: Date.now() / 1000,
      kph: round(kph, 2), gps_kph: round(gps_kph, 2),
      mph: round(kph, 2), unit: 'KPH',
      mode,
      thr_pct: round(thr, 0), brk_pct: round(brk, 0),
      regen_pct: round(regen, 0), pwr_pct: round(thr, 0),
      bus_v: round(bus_v, 2), supply_a: round(supply_a, 2),
      stator_a: round(stator_a, 2), temp_c: round(temp_c, 1),
      seen: 1, warn: warnFlag, gps: 1, sats: 9, foc: 1, faults,
    };
    onLine(JSON.stringify(pkt));
  }, 500);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      onLine(JSON.stringify({ type: 'run_end', run: runId, ts: Date.now() / 1000, seq: seq++ }));
      if (onEnd) onEnd();
    },
    isRunning() { return !stopped; },
  };
}

/**
 * Replay a Pi CSV through the LoRa parser at chosen speed multiplier.
 * Returns a controller with .stop().
 */
export function startCsvReplay({ csvText, speed = 5, onLine, onEnd }) {
  const rows = parseCsvText(csvText);
  const samples = rows
    .map((row, i) => parseCsvRow(row, i))
    .filter((s) => Number.isFinite(s.ts));

  if (samples.length === 0) {
    if (onEnd) onEnd('no usable rows');
    return { stop() {}, count: 0 };
  }

  let i = 0;
  let timer = null;
  const baseTs = samples[0].ts;
  const startedWall = Date.now() / 1000;
  let stopped = false;

  const tick = () => {
    if (stopped || i >= samples.length) {
      if (onEnd) onEnd(stopped ? 'stopped' : 'done');
      return;
    }
    const s = samples[i];
    const restamped = { ...s, ts: startedWall + (s.ts - baseTs) / speed };
    onLine(sampleToLoraLine(restamped));
    i += 1;
    if (i < samples.length) {
      const dt = (samples[i].ts - samples[i - 1].ts) / speed;
      timer = setTimeout(tick, Math.max(0, Math.min(2000, dt * 1000)));
    } else if (onEnd) onEnd('done');
  };
  tick();

  return {
    stop() {
      stopped = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
    },
    count: samples.length,
  };
}
