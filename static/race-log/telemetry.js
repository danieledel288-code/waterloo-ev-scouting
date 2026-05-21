// LoRa + Pi CSV telemetry parsing for the Waterloo EV pit-wall RACE LOG page.
// Pure module — no DOM, no framework. Mirrors the React app's telemetry.ts so
// the two stay behavior-compatible.
//
// Sample shape (after normalisation, all fields optional except ts & time_s):
//   { time_s, ts, kph, gps_kph, mode, thr_pct, brk_pct, regen_pct, pwr_pct,
//     vcmd, brake_torque_a, brake_control, bus_v, supply_a, stator_a, temp_c,
//     rps_avg, wh, wh_used, wh_recovered, net_wh, distance_km, wh_per_km,
//     gps, sats, foc, seen, warn, faults: [...], seq, run, raw,
//     // per-motor (Kraken X60 × 2):
//     kph_cmd, err_kph, m1_a, m1_t, m1_v, m1_c, m1_foc, m2_a, m2_t, m2_v, m2_c, m2_foc }

const num = (v) => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};

const normalizeFaults = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (v === null || v === undefined) return [];
  const s = String(v).trim();
  if (!s) return [];
  return s.split(/[;,|]/).map((x) => x.trim()).filter(Boolean);
};

/**
 * Parse one newline-delimited LoRa line into a race event.
 * Returns { type, recv_at, sample?, faults?, seq?, run?, message?, raw }.
 * Never throws; bad input → { type: 'parse_error', message, raw }.
 */
export function parseLoraLine(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      recv_at: Date.now(),
      type: 'parse_error',
      message: 'JSON parse failed',
      raw: trimmed.length > 400 ? trimmed.slice(0, 400) + '…' : trimmed,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { recv_at: Date.now(), type: 'parse_error', message: 'not an object', raw: trimmed };
  }

  // Deployed Pi always sends unit:"KPH". Anything else = silent mislabel risk.
  if (typeof parsed.unit === 'string' && parsed.unit !== 'KPH') {
    return {
      recv_at: Date.now(),
      type: 'parse_error',
      message: `unexpected unit "${parsed.unit}" — expected KPH`,
      raw: trimmed,
    };
  }

  const t = typeof parsed.type === 'string' ? parsed.type : undefined;
  if (t === 'hello' || t === 'run_start' || t === 'run_end' || t === 'heartbeat' || t === 'marker') {
    return {
      recv_at: Date.now(), type: t,
      seq: num(parsed.seq),
      run: typeof parsed.run === 'string' ? parsed.run : undefined,
      message: typeof parsed.msg === 'string' ? parsed.msg : undefined,
      raw: trimmed,
    };
  }
  if (t === 'fault') {
    return {
      recv_at: Date.now(), type: 'fault',
      seq: num(parsed.seq),
      run: typeof parsed.run === 'string' ? parsed.run : undefined,
      faults: normalizeFaults(parsed.faults),
      raw: trimmed,
    };
  }

  // Default: sample. Tolerates both current real-packet keys (busV/tempC/...) and
  // the canonical snake_case shape.
  const ts = num(parsed.ts) ?? Date.now() / 1000;

  const sample = {
    time_s: 0,
    ts,
    kph: num(parsed.kph),
    gps_kph: num(parsed.gps_kph),
    mode: typeof parsed.mode === 'string' ? parsed.mode : undefined,
    thr_pct: num(parsed.thr_pct) ?? num(parsed.thr),
    brk_pct: num(parsed.brk_pct) ?? num(parsed.brk),
    regen_pct: num(parsed.regen_pct) ?? num(parsed.regen),
    pwr_pct: num(parsed.pwr_pct) ?? num(parsed.pwr),
    vcmd: num(parsed.vcmd) ?? num(parsed.cmdV),
    torque_cmd_a: num(parsed.torque_cmd_a) ?? num(parsed.torqueA),
    control_mode: typeof parsed.control_mode === 'string' ? parsed.control_mode : (typeof parsed.control === 'string' ? parsed.control : undefined),
    brake_torque_a: num(parsed.brake_torque_a) ?? num(parsed.brakeTorqueA),
    brake_control: typeof parsed.brake_control === 'string' ? parsed.brake_control : undefined,
    bus_v: num(parsed.bus_v) ?? num(parsed.busV),
    supply_a: num(parsed.supply_a) ?? num(parsed.amps),
    stator_a: num(parsed.stator_a),
    temp_c: num(parsed.temp_c) ?? num(parsed.tempC),
    rps_avg: num(parsed.rps_avg) ?? num(parsed.rps),
    wh: num(parsed.wh),
    wh_used: num(parsed.wh_used) ?? num(parsed.whUsed),
    wh_recovered: num(parsed.wh_recovered) ?? num(parsed.whRegen),
    net_wh: num(parsed.net_wh) ?? num(parsed.wh),
    distance_km: num(parsed.distance_km) ?? num(parsed.km),
    wh_per_km: num(parsed.wh_per_km) ?? num(parsed.whPerKm),
    gps: num(parsed.gps),
    sats: num(parsed.sats),
    foc: num(parsed.foc),
    seen: num(parsed.seen) ?? num(parsed.drive_seen),
    warn: num(parsed.warn),
    faults: normalizeFaults(parsed.faults),
    seq: num(parsed.seq),
    run: typeof parsed.run === 'string' ? parsed.run : undefined,
    raw: trimmed,
    // Drivetrain
    kph_cmd: num(parsed.kph_cmd) ?? num(parsed.kphCmd),
    err_kph: num(parsed.err_kph) ?? num(parsed.errKph),
    m1_a: num(parsed.m1_a),
    m1_t: num(parsed.m1_t),
    m1_v: num(parsed.m1_v),
    m1_c: num(parsed.m1_c),
    m1_foc: num(parsed.m1_foc),
    m2_a: num(parsed.m2_a),
    m2_t: num(parsed.m2_t),
    m2_v: num(parsed.m2_v),
    m2_c: num(parsed.m2_c),
    m2_foc: num(parsed.m2_foc),
  };

  return {
    recv_at: Date.now(), type: 'sample',
    seq: sample.seq, run: sample.run,
    sample, faults: sample.faults, raw: trimmed,
  };
}

/** Parse one Pi CSV row into a Sample. */
export function parseCsvRow(row, idx) {
  const ts = num(row.ts) ?? idx;
  return {
    time_s: 0,
    ts,
    kph: num(row.kph),
    gps_kph: num(row.gps_kph),
    mode: row.mode || undefined,
    thr_pct: num(row.thr_pct),
    brk_pct: num(row.brk_pct),
    regen_pct: num(row.regen_pct),
    pwr_pct: num(row.pwr_pct),
    vcmd: num(row.vcmd),
    torque_cmd_a: num(row.torque_cmd_a),
    control_mode: row.control_mode || undefined,
    bus_v: num(row.bus_v),
    supply_a: num(row.supply_a),
    stator_a: num(row.stator_a),
    temp_c: num(row.temp_c),
    rps_avg: num(row.rps_avg),
    wh: num(row.wh),
    wh_used: num(row.wh_used),
    wh_recovered: num(row.wh_recovered),
    net_wh: num(row.net_wh),
    distance_km: num(row.distance_km),
    wh_per_km: num(row.wh_per_km),
    gps: num(row.gps),
    sats: num(row.sats),
    foc: num(row.foc),
    seen: num(row.drive_seen) ?? num(row.seen),
    warn: num(row.warn),
    faults: normalizeFaults(row.faults),
  };
}

/** Light CSV parser — handles quoted fields and the deployed Pi-logger schema. */
export function parseCsvText(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return rows;
  const header = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < header.length; c++) row[header[c]] = cells[c] ?? '';
    rows.push(row);
  }
  return rows;
}
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else if (ch === '"') {
      inQuote = true;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Re-anchor `time_s` so the first sample is at t=0. */
export function rebaseTimes(samples) {
  if (samples.length === 0) return samples;
  const first = samples[0].ts;
  return samples.map((s) => ({ ...s, time_s: Math.max(0, s.ts - first) }));
}

/** Aggregate a list of Samples into a RunSummary. */
export function computeSummary(samples) {
  let topKph = 0, topGpsKph = 0, maxSupplyA = 0, maxStatorA = 0;
  let minBusV = null, maxTempC = 0;
  let netWh = 0, whPerKm = 0, distanceKm = 0;
  let movingSum = 0, movingCount = 0;
  const modeMs = {};
  const faultSet = new Set();
  let faultCount = 0, missedSeq = 0;
  let prevSeq = null, prevTs = null, prevMode;

  for (const s of samples) {
    if (s.kph !== undefined) topKph = Math.max(topKph, s.kph);
    if (s.gps_kph !== undefined) topGpsKph = Math.max(topGpsKph, s.gps_kph);
    if (s.supply_a !== undefined) maxSupplyA = Math.max(maxSupplyA, s.supply_a);
    if (s.stator_a !== undefined) maxStatorA = Math.max(maxStatorA, s.stator_a);
    if (s.bus_v !== undefined) minBusV = minBusV === null ? s.bus_v : Math.min(minBusV, s.bus_v);
    if (s.temp_c !== undefined) maxTempC = Math.max(maxTempC, s.temp_c);
    if (s.net_wh !== undefined) netWh = s.net_wh;
    else if (s.wh !== undefined) netWh = s.wh;
    if (s.wh_per_km !== undefined) whPerKm = s.wh_per_km;
    if (s.distance_km !== undefined) distanceKm = s.distance_km;
    if (s.kph !== undefined && s.kph > 1) { movingSum += s.kph; movingCount += 1; }
    if (s.faults && s.faults.length > 0) {
      faultCount += s.faults.length;
      for (const f of s.faults) faultSet.add(f);
    }
    if (s.seq !== undefined) {
      if (prevSeq !== null && s.seq > prevSeq + 1) missedSeq += s.seq - prevSeq - 1;
      prevSeq = s.seq;
    }
    if (prevTs !== null && prevMode) {
      const dt = (s.ts - prevTs) * 1000;
      if (dt > 0 && dt < 5000) modeMs[prevMode] = (modeMs[prevMode] ?? 0) + dt;
    }
    prevTs = s.ts;
    prevMode = s.mode || prevMode;
  }

  const durationS = samples.length > 1 ? samples[samples.length - 1].ts - samples[0].ts : 0;
  const avgMovingKph = movingCount > 0 ? movingSum / movingCount : 0;
  const estLap1kmS = avgMovingKph > 0 ? 3600 / avgMovingKph : null;
  return {
    sampleCount: samples.length, durationS,
    topKph, topGpsKph, avgMovingKph, estLap1kmS,
    maxSupplyA, maxStatorA, minBusV, maxTempC,
    netWh, whPerKm, distanceKm,
    modeMs, faultCount, uniqueFaults: Array.from(faultSet),
    missedSeq,
  };
}

/** Pi-logger column order — exact match for race_logger.py CSV output. */
export const PI_CSV_COLUMNS = [
  'ts','kph','gps_kph','gps','sats','mode','drive_seen','thr_pct','brk_pct',
  'regen_pct','pwr_pct','vcmd','torque_cmd_a','control_mode','thr_v','brk_v','bus_v','supply_a','stator_a',
  'temp_c','rps_avg','pro','foc','regen_enabled','wh_used','wh_recovered',
  'net_wh','distance_km','wh_per_km','faults',
];

const csvEscape = (v) => {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function samplesToCsv(samples) {
  const out = [PI_CSV_COLUMNS.join(',')];
  for (const s of samples) {
    out.push([
      s.ts ?? '', s.kph ?? '', s.gps_kph ?? '', s.gps ?? '', s.sats ?? '',
      s.mode ?? '', s.seen ?? '',
      s.thr_pct ?? '', s.brk_pct ?? '', s.regen_pct ?? '', s.pwr_pct ?? '', s.vcmd ?? '',
      s.torque_cmd_a ?? '', s.control_mode ?? '',
      '', '',  // thr_v, brk_v — not in LoRa packets
      s.bus_v ?? '', s.supply_a ?? '', s.stator_a ?? '', s.temp_c ?? '', s.rps_avg ?? '',
      s.seen ?? '',  // pro mirrors drive_seen
      s.foc ?? '',
      '',
      s.wh_used ?? '',
      s.wh_recovered ?? '',
      s.net_wh ?? s.wh ?? '',
      s.distance_km ?? '',
      s.wh_per_km ?? '',
      (s.faults && s.faults.length > 0) ? s.faults.join(';') : '',
    ].map(csvEscape).join(','));
  }
  return out.join('\n');
}

/** Serialize a Sample back into a deployed-Pi-shape LoRa line (for replay). */
export function sampleToLoraLine(s) {
  const pkt = {
    kph: s.kph, gps_kph: s.gps_kph, mph: s.kph, unit: 'KPH',
    mode: s.mode, pwr: s.pwr_pct, regen: s.regen_pct, thr: s.thr_pct, brk: s.brk_pct,
    cmdV: s.vcmd, torqueA: s.torque_cmd_a, control: s.control_mode,
    tempC: s.temp_c, busV: s.bus_v, amps: s.supply_a, rps: s.rps_avg,
    wh: s.net_wh ?? s.wh, whUsed: s.wh_used, whRegen: s.wh_recovered,
    km: s.distance_km, whPerKm: s.wh_per_km,
    seen: s.seen, faults: s.faults ?? [], gps: s.gps, sats: s.sats,
    warn: s.warn, foc: s.foc, ts: s.ts,
  };
  for (const k of Object.keys(pkt)) if (pkt[k] === undefined) delete pkt[k];
  return JSON.stringify(pkt);
}

export const formatNum = (v, digits = 1, fb = '—') =>
  (v === undefined || v === null || !Number.isFinite(v)) ? fb : v.toFixed(digits);

export const formatDuration = (s) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
};
