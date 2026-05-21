// Race-log page controller.
// Wires together parser + Web Serial + mock + replay + Pi CSV import
// against the DOM rendered by templates/race_log.html.

import {
  parseLoraLine, parseCsvText, parseCsvRow, computeSummary, rebaseTimes,
  samplesToCsv, formatNum, formatDuration,
} from './telemetry.js';
import { isWebSerialSupported, connectLora } from './serial.js';
import { startMockStream, startCsvReplay } from './streams.js';

// --- State ----------------------------------------------------------------
const SAMPLE_CAP = 10000;
const EVENT_CAP = 8000;

const state = {
  connection: 'idle',          // 'idle' | 'connecting' | 'connected' | 'mock' | 'replay' | 'error'
  linkLost: false,
  events: [],
  samples: [],
  packetCount: 0,
  parseErrorCount: 0,
  missedSeq: 0,
  lastPacketAt: null,
  currentRun: null,
  filter: 'all',
  enabledSignals: { kph: true, kph_cmd: false, gps_kph: true, err_kph: false, bus_v: true, supply_a: true, stator_a: false, m1_a: false, m2_a: false, temp_c: false },
  csvSamples: null,
  csvFilename: null,
  replaySpeed: 10,
  replayPending: null,         // { samples, name }
};

const lastSeqByRun = {};
let runAnchorTs = null;
let serialCtrl = null;
let mockCtrl = null;
let replayCtrl = null;

// --- Decimation -----------------------------------------------------------
const decimateIfNeeded = (buf, cap) => {
  if (buf.length <= cap) return buf;
  const out = [];
  for (let i = 0; i < buf.length - 1; i += 2) out.push(buf[i]);
  out.push(buf[buf.length - 1]);
  return out;
};

// --- Packet handler -------------------------------------------------------
function handleLine(line) {
  const evt = parseLoraLine(line);
  if (!evt) return;

  state.events = decimateIfNeeded(state.events.concat(evt), EVENT_CAP);

  if (evt.type === 'parse_error') {
    state.parseErrorCount += 1;
    scheduleRender();
    return;
  }

  state.packetCount += 1;
  state.lastPacketAt = Date.now();
  state.linkLost = false;
  if (evt.run) state.currentRun = evt.run;

  if (evt.type === 'run_start') {
    runAnchorTs = null;
    for (const k of Object.keys(lastSeqByRun)) delete lastSeqByRun[k];
    state.samples = [];
    state.missedSeq = 0;
    scheduleRender();
    return;
  }
  if (evt.type === 'run_end') { scheduleRender(); return; }

  if (evt.type === 'sample' && evt.sample) {
    const s = evt.sample;
    if (runAnchorTs === null) runAnchorTs = s.ts;
    const samp = { ...s, time_s: Math.max(0, s.ts - runAnchorTs) };
    const runKey = evt.run ?? '__default__';
    if (s.seq !== undefined) {
      const prev = lastSeqByRun[runKey];
      if (prev !== undefined && s.seq > prev + 1) state.missedSeq += s.seq - prev - 1;
      lastSeqByRun[runKey] = s.seq;
    }
    // Dedup last seq
    const last = state.samples[state.samples.length - 1];
    if (last && s.seq !== undefined && last.run === samp.run && last.seq === samp.seq) {
      scheduleRender();
      return;
    }
    state.samples = decimateIfNeeded(state.samples.concat(samp), SAMPLE_CAP);
  }
  scheduleRender();
}

// --- Connection actions ---------------------------------------------------
async function connect() {
  if (['connected','connecting','mock','replay'].includes(state.connection)) return;
  state.connection = 'connecting';
  state.linkLost = false;
  render();
  try {
    serialCtrl = await connectLora({
      onLine: handleLine,
      onClose: (reason) => {
        const userInitiated = reason === 'disconnected';
        serialCtrl = null;
        if (!userInitiated && state.packetCount > 0) state.linkLost = true;
        state.connection = 'idle';
        render();
      },
    });
    state.connection = 'connected';
  } catch (err) {
    state.connection = 'error';
    console.error(err);
    alert(err.message ?? String(err));
  }
  render();
}

async function disconnect() {
  if (serialCtrl)  { await serialCtrl.disconnect(); serialCtrl = null; }
  if (mockCtrl)    { mockCtrl.stop(); mockCtrl = null; }
  if (replayCtrl)  { replayCtrl.stop(); replayCtrl = null; }
  state.connection = 'idle';
  state.linkLost = false;
  render();
}

function startMock() {
  if (mockCtrl?.isRunning()) return;
  state.connection = 'mock';
  state.linkLost = false;
  mockCtrl = startMockStream({
    onLine: handleLine,
    onEnd: () => { mockCtrl = null; state.connection = 'idle'; render(); },
  });
  render();
}
function stopMock() { if (mockCtrl) { mockCtrl.stop(); mockCtrl = null; } state.connection = 'idle'; render(); }

function clearRun() {
  state.events = []; state.samples = [];
  state.packetCount = 0; state.parseErrorCount = 0; state.missedSeq = 0;
  state.lastPacketAt = null; state.currentRun = null;
  state.linkLost = false;
  runAnchorTs = null;
  for (const k of Object.keys(lastSeqByRun)) delete lastSeqByRun[k];
  render();
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const payload = {
    exported_at: new Date().toISOString(),
    run: state.currentRun,
    packet_count: state.packetCount,
    parse_error_count: state.parseErrorCount,
    missed_seq: state.missedSeq,
    events: state.events,
    samples: state.samples,
  };
  triggerDownload(
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `lora-race-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
}
function exportCsv() {
  if (!state.samples.length) return;
  triggerDownload(
    new Blob([samplesToCsv(state.samples)], { type: 'text/csv' }),
    `lora-race-log-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  );
}

// --- Pi CSV import --------------------------------------------------------
function importCsvFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCsvText(String(reader.result));
    const samples = rows.map((row, i) => parseCsvRow(row, i)).filter(s => Number.isFinite(s.ts));
    if (samples.length === 0) { alert('CSV had no usable rows.'); return; }
    state.csvSamples = rebaseTimes(samples);
    state.csvFilename = file.name;
    render();
  };
  reader.readAsText(file);
}
function clearCsv() { state.csvSamples = null; state.csvFilename = null; render(); }

// --- Replay ---------------------------------------------------------------
function chooseReplayFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    state.replayPending = { csvText: String(reader.result), name: file.name };
    render();
  };
  reader.readAsText(file);
}
function startReplay() {
  if (!state.replayPending) return;
  state.connection = 'replay';
  state.linkLost = false;
  replayCtrl = startCsvReplay({
    csvText: state.replayPending.csvText,
    speed: state.replaySpeed,
    onLine: handleLine,
    onEnd: () => { replayCtrl = null; if (state.connection === 'replay') state.connection = 'idle'; render(); },
  });
  render();
}
function stopReplay() { if (replayCtrl) { replayCtrl.stop(); replayCtrl = null; } state.connection = 'idle'; render(); }

// --- Status classification ------------------------------------------------
function statusOf() {
  const faults = state.samples[state.samples.length - 1]?.faults ?? [];
  const isStale = state.lastPacketAt !== null && state.packetCount > 0
    && (Date.now() - state.lastPacketAt) > 2000
    && ['connected','mock','replay'].includes(state.connection);

  if (state.linkLost) return { label: 'LINK LOST', cls: 'is-linklost' };
  if (faults.length > 0) return { label: 'FAULT', cls: 'is-fault' };
  if (state.connection === 'replay' && state.packetCount > 0) return { label: 'REPLAY', cls: 'is-replay' };
  if (state.connection === 'mock' && !isStale && state.packetCount > 0) return { label: 'RUNNING (MOCK)', cls: 'is-mock' };
  if (state.connection === 'connected' && !isStale && state.packetCount > 0) return { label: 'RUNNING', cls: 'is-running' };
  if (isStale) return { label: 'STALE', cls: 'is-stale' };
  if (state.packetCount === 0) return { label: 'IDLE', cls: '' };
  return { label: 'ENDED', cls: 'is-ended' };
}

// --- Render ---------------------------------------------------------------
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const $ = (id) => document.getElementById(id);
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const setClass = (id, cls) => { const el = $(id); if (el) el.className = cls; };

function render() {
  const latest = state.samples[state.samples.length - 1];
  const status = statusOf();

  // Status strip
  setText('rl-status-badge', status.label);
  setClass('rl-status-badge', `rl-status-badge ${status.cls}`);
  setClass('rl-bar', `rl-strip-bar ${status.cls}`);

  const modeBadge = $('rl-mode-badge');
  if (latest?.mode) { modeBadge.textContent = latest.mode; modeBadge.style.display = ''; }
  else { modeBadge.style.display = 'none'; }

  setText('rl-kph', formatNum(latest?.kph, 1, '--'));
  setText('rl-gps-kph', formatNum(latest?.gps_kph, 1, '--'));

  const busVEl = $('rl-bus-v');
  const busWarn = latest?.bus_v !== undefined && latest.bus_v < 10.5;
  busVEl.textContent = formatNum(latest?.bus_v, 2, '--');
  busVEl.className = `tile-val mono${busWarn ? ' warn' : ''}`;

  setText('rl-supply-a', formatNum(latest?.supply_a, 1, '--'));

  const tempEl = $('rl-temp-c');
  const tempWarn = latest?.temp_c !== undefined && latest.temp_c > 60;
  tempEl.textContent = formatNum(latest?.temp_c, 1, '--');
  tempEl.parentElement.className = `tile-val mono${tempWarn ? ' warn' : ''}`;

  // ESC / GPS health chips
  const escChip = $('rl-esc-chip');
  if (latest?.seen === undefined) { escChip.textContent = 'ESC —'; escChip.className = 'rl-chip rl-chip-mut'; }
  else if (latest.seen === 1)     { escChip.textContent = 'ESC SEEN'; escChip.className = 'rl-chip rl-chip-green'; }
  else                            { escChip.textContent = 'ESC NOT SEEN'; escChip.className = 'rl-chip rl-chip-amber'; }

  const gpsChip = $('rl-gps-chip');
  if (latest?.gps === 1) {
    gpsChip.textContent = `GPS · ${latest.sats ?? 0} sats`;
    gpsChip.className = 'rl-chip rl-chip-green';
  } else {
    gpsChip.textContent = `GPS — · ${latest?.sats ?? 0}`;
    gpsChip.className = 'rl-chip rl-chip-mut';
  }

  // Fault chip
  const fc = $('rl-fault-chip');
  const faults = latest?.faults ?? [];
  if (faults.length > 0) { fc.textContent = `⚠ ${faults[faults.length - 1]}`; fc.className = 'rl-chip rl-chip-red'; }
  else if (latest?.warn === 1) { fc.textContent = 'PI WARN'; fc.className = 'rl-chip rl-chip-amber'; }
  else { fc.textContent = 'NO FAULTS'; fc.className = 'rl-chip rl-chip-mut'; }

  // Connection panel
  const connChip = $('rl-conn-chip');
  if (state.linkLost)                          { connChip.textContent = 'LINK LOST'; connChip.className = 'rl-chip rl-chip-red'; }
  else if (state.connection === 'connected')   { connChip.textContent = 'LORA LIVE'; connChip.className = 'rl-chip rl-chip-green'; }
  else if (state.connection === 'mock')        { connChip.textContent = 'MOCK STREAM'; connChip.className = 'rl-chip rl-chip-amber'; }
  else if (state.connection === 'replay')      { connChip.textContent = 'REPLAY'; connChip.className = 'rl-chip rl-chip-cyan'; }
  else if (state.connection === 'connecting')  { connChip.textContent = 'CONNECTING…'; connChip.className = 'rl-chip rl-chip-amber'; }
  else if (state.connection === 'error')       { connChip.textContent = 'ERROR'; connChip.className = 'rl-chip rl-chip-red'; }
  else                                         { connChip.textContent = 'IDLE'; connChip.className = 'rl-chip rl-chip-mut'; }

  const supported = isWebSerialSupported();
  $('rl-noserial-banner').classList.toggle('hidden', supported);
  $('rl-linklost-banner').classList.toggle('hidden', !state.linkLost);

  const busy = ['connecting','connected','mock','replay'].includes(state.connection);
  $('rl-btn-connect').disabled = !supported || busy;
  $('rl-btn-disconnect').disabled = !busy;
  $('rl-btn-mock').textContent = state.connection === 'mock' ? 'STOP MOCK' : 'START MOCK';
  $('rl-btn-mock').disabled = busy && state.connection !== 'mock';
  $('rl-btn-export-json').disabled = state.packetCount === 0;
  $('rl-btn-export-csv').disabled = state.samples.length === 0;

  setText('rl-packets', state.packetCount);
  const peEl = $('rl-parse-err'); peEl.textContent = state.parseErrorCount;
  peEl.className = `rl-stat-val${state.parseErrorCount > 0 ? ' warn' : ''}`;
  const msEl = $('rl-missed-seq'); msEl.textContent = state.missedSeq;
  msEl.className = `rl-stat-val${state.missedSeq > 0 ? ' warn' : ''}`;
  const ageS = state.lastPacketAt ? Math.max(0, (Date.now() - state.lastPacketAt) / 1000).toFixed(1) : '—';
  const lp = $('rl-last-pkt'); lp.textContent = `${ageS}s ago`;
  lp.className = `rl-stat-val${(status.cls === 'is-stale' || state.linkLost) ? ' warn' : ''}`;
  setText('rl-run-id', state.currentRun ? state.currentRun.slice(0, 19) : '—');
  setText('rl-source',
    state.connection === 'mock' ? 'MOCK' :
    state.connection === 'connected' ? 'SERIAL' :
    state.connection === 'replay' ? 'REPLAY' : 'IDLE',
  );

  // CSV import
  const csvChip = $('rl-csv-chip');
  if (state.csvFilename) {
    csvChip.textContent = 'LOADED'; csvChip.className = 'rl-chip rl-chip-green';
    $('rl-csv-help').innerHTML = `<span class="mono">${state.csvFilename}</span> · ${state.csvSamples.length} ROWS LOADED · BACKUP VIEW RENDERED BELOW.`;
    $('rl-btn-csv-clear').classList.remove('hidden');
  } else {
    csvChip.textContent = 'NO FILE'; csvChip.className = 'rl-chip rl-chip-mut';
    $('rl-csv-help').innerHTML = `UPLOAD <span class="mono">race-YYYYMMDD-HHMMSS.csv</span> FROM THE PI TO LOAD DETAILED TELEMETRY.`;
    $('rl-btn-csv-clear').classList.add('hidden');
  }

  // Replay panel
  const replayChip = $('rl-replay-chip');
  if (state.connection === 'replay') { replayChip.textContent = 'REPLAY ACTIVE'; replayChip.className = 'rl-chip rl-chip-cyan'; }
  else if (state.replayPending)      { replayChip.textContent = 'READY'; replayChip.className = 'rl-chip rl-chip-amber'; }
  else                               { replayChip.textContent = 'IDLE'; replayChip.className = 'rl-chip rl-chip-mut'; }
  $('rl-btn-replay-start').disabled = !state.replayPending || state.connection === 'replay';
  $('rl-btn-replay-start').classList.toggle('hidden', state.connection === 'replay');
  $('rl-btn-replay-stop').classList.toggle('hidden', state.connection !== 'replay');
  if (state.replayPending) {
    $('rl-replay-help').innerHTML = `<span class="mono">${state.replayPending.name}</span> READY · ${state.replaySpeed}× SPEED. STREAMS THROUGH THE SAME LORA PARSER THE RADIO FEEDS.`;
  } else {
    $('rl-replay-help').innerHTML = `LOAD ANY <span class="mono">race-*.csv</span> TO REHEARSE THE LIVE DASHBOARD. STATUS STRIP WILL BADGE REPLAY SO YOU DON'T MISTAKE IT FOR THE LIVE CAR.`;
  }
  Array.from(document.querySelectorAll('#rl-speed-group .rl-pill')).forEach((btn) => {
    btn.classList.toggle('rl-pill-on', Number(btn.dataset.speed) === state.replaySpeed);
  });

  // Summary
  renderSummary();
  // Timeline
  renderChart();
  // Event log
  renderEventLog();
  // Drivetrain
  renderDrivetrain(latest);
  // Bus-V sparkline
  renderBusSparkline();
}

function renderSummary() {
  const sum = computeSummary(state.samples);
  const stats = [
    { k: 'TOP KPH',        v: formatNum(sum.topKph, 1), warn: false },
    { k: 'TOP GPS KPH',    v: formatNum(sum.topGpsKph, 1) },
    { k: 'AVG MOVING KPH', v: formatNum(sum.avgMovingKph, 1) },
    { k: 'EST 1KM LAP',    v: sum.estLap1kmS ? formatDuration(sum.estLap1kmS) : '—' },
    { k: 'MAX SUPPLY A',   v: formatNum(sum.maxSupplyA, 1), warn: sum.maxSupplyA > 80 },
    { k: 'MAX STATOR A',   v: formatNum(sum.maxStatorA, 1) },
    { k: 'MIN BUS V',      v: formatNum(sum.minBusV ?? undefined, 2), warn: (sum.minBusV ?? 99) < 10.5 },
    { k: 'MAX TEMP °C',    v: formatNum(sum.maxTempC, 1), warn: sum.maxTempC > 60 },
    { k: 'NET WH',         v: formatNum(sum.netWh, 1) },
    { k: 'WH/KM',          v: formatNum(sum.whPerKm, 1), warn: sum.whPerKm > 25 },
    { k: 'DIST KM',        v: formatNum(sum.distanceKm, 2) },
    { k: 'FAULTS',         v: String(sum.faultCount), warn: sum.faultCount > 0 },
    { k: 'PACKETS',        v: String(sum.sampleCount) },
    { k: 'MISSED SEQ',     v: String(sum.missedSeq), warn: sum.missedSeq > 0 },
    { k: 'DURATION',       v: formatDuration(sum.durationS) },
  ];
  $('rl-summary').innerHTML = stats.map(s =>
    `<div><span class="microlabel">${s.k}</span><span class="val${s.warn ? ' warn' : ''}">${s.v}</span></div>`
  ).join('');
}

// --- Timeline chart (custom SVG, no library) ------------------------------
const SIGNALS = [
  { key: 'kph',     label: 'WHEEL KPH', color: '#f4f1ea' },
  { key: 'kph_cmd', label: 'CMD KPH',   color: '#ffd400' },
  { key: 'gps_kph', label: 'GPS KPH',   color: '#a8a39a' },
  { key: 'err_kph', label: 'ERR KPH',   color: '#c084fc' },
  { key: 'bus_v',   label: 'BUS V',     color: '#4ad8ff' },
  { key: 'supply_a',label: 'SUPPLY A',  color: '#ff2a1a' },
  { key: 'stator_a',label: 'STATOR A',  color: '#faff00' },
  { key: 'm1_a',    label: 'M1 STAT A', color: '#38bdf8' },
  { key: 'm2_a',    label: 'M2 STAT A', color: '#2bff8a' },
  { key: 'temp_c',  label: 'TEMP °C',   color: '#fb923c' },
];

function renderToggles() {
  const wrap = $('rl-toggles');
  wrap.innerHTML = SIGNALS.map(sig =>
    `<button class="rl-toggle ${state.enabledSignals[sig.key] ? 'is-on' : ''}"
            data-sig="${sig.key}"
            style="border-bottom: 3px solid ${state.enabledSignals[sig.key] ? sig.color : 'transparent'};">${sig.label}</button>`
  ).join('');
}

function renderChart() {
  const svg = $('rl-chart');
  const W = 1000, H = 280, PAD_L = 8, PAD_R = 8, PAD_T = 8, PAD_B = 16;
  const samples = state.samples;
  $('rl-chart-empty').style.display = samples.length === 0 ? '' : 'none';
  if (samples.length === 0) { svg.innerHTML = ''; $('rl-chart-axis').innerHTML = ''; return; }

  const tMin = samples[0].time_s;
  const tMax = samples[samples.length - 1].time_s || tMin + 1;
  const tRange = Math.max(0.001, tMax - tMin);
  const xOf = t => PAD_L + ((t - tMin) / tRange) * (W - PAD_L - PAD_R);

  // Build lines for enabled signals.
  const paths = [];
  // Grid lines
  let grid = '';
  for (let i = 1; i < 4; i++) {
    const y = PAD_T + ((H - PAD_T - PAD_B) * i) / 4;
    grid += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#1a1a1a" stroke-width="1"/>`;
  }
  // Determine independent y-range per signal (so wildly different ranges still visible)
  for (const sig of SIGNALS) {
    if (!state.enabledSignals[sig.key]) continue;
    let vMin = Infinity, vMax = -Infinity;
    for (const s of samples) {
      const v = s[sig.key];
      if (typeof v === 'number') { if (v < vMin) vMin = v; if (v > vMax) vMax = v; }
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) continue;
    if (vMin === vMax) { vMin -= 0.5; vMax += 0.5; }
    const vRange = vMax - vMin;
    const yOf = v => PAD_T + (H - PAD_T - PAD_B) * (1 - (v - vMin) / vRange);

    // Downsample to ~600 pts for the SVG
    const step = Math.max(1, Math.ceil(samples.length / 600));
    let d = '';
    let first = true;
    for (let i = 0; i < samples.length; i += step) {
      const s = samples[i];
      const v = s[sig.key];
      if (typeof v !== 'number') continue;
      const x = xOf(s.time_s).toFixed(1);
      const y = yOf(v).toFixed(1);
      d += `${first ? 'M' : 'L'} ${x} ${y} `;
      first = false;
    }
    if (d) paths.push(`<path d="${d}" fill="none" stroke="${sig.color}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`);
  }
  svg.innerHTML = `${grid}${paths.join('')}`;

  // Axis labels (0s, 25%, 50%, 75%, end)
  const axis = $('rl-chart-axis');
  const labels = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const t = tMin + tRange * f;
    return `<span>${t.toFixed(0)}s</span>`;
  }).join('');
  axis.innerHTML = labels;
}

// --- Event log ------------------------------------------------------------
function renderEventLog() {
  const filtered = state.events.filter(e => {
    if (state.filter === 'all') return true;
    if (state.filter === 'samples') return e.type === 'sample';
    if (state.filter === 'faults') return e.type === 'fault' || (e.faults && e.faults.length > 0);
    if (state.filter === 'markers') return ['marker','run_start','run_end','hello','heartbeat'].includes(e.type);
    if (state.filter === 'parse_errors') return e.type === 'parse_error';
    return true;
  }).slice(-200).reverse();

  const rows = filtered.length === 0
    ? `<tr><td colspan="9" class="muted" style="text-align:center; padding: 1.4rem;">NO EVENTS</td></tr>`
    : filtered.map(e => {
        const t = new Date(e.recv_at).toLocaleTimeString([], { hour12: false });
        const detail = e.faults?.length > 0 ? `<span class="type-fault">${e.faults.join(', ')}</span>`
                     : e.message ? e.message
                     : e.raw ? `<span class="muted">${escapeHtml(e.raw.length > 60 ? e.raw.slice(0,60)+'…' : e.raw)}</span>`
                     : '—';
        return `<tr>
          <td class="muted">${t}</td>
          <td class="type-${e.type}">${e.type}</td>
          <td class="muted">${e.seq ?? '—'}</td>
          <td>${e.sample?.mode ?? '—'}</td>
          <td class="num">${formatNum(e.sample?.kph, 1)}</td>
          <td class="num">${formatNum(e.sample?.bus_v, 2)}</td>
          <td class="num">${formatNum(e.sample?.supply_a, 1)}</td>
          <td class="num">${formatNum(e.sample?.temp_c, 1)}</td>
          <td>${detail}</td>
        </tr>`;
      }).join('');
  $('rl-log-body').innerHTML = rows;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

// --- Drivetrain -----------------------------------------------------------
function renderDrivetrain(latest) {
  const hasPerMotor = latest && (
    latest.m1_a !== undefined || latest.m2_a !== undefined ||
    latest.m1_t !== undefined || latest.m2_t !== undefined
  );
  $('rl-drivetrain-empty').classList.toggle('hidden', !!hasPerMotor);
  $('rl-drivetrain-live').classList.toggle('hidden', !hasPerMotor);
  const chip = $('rl-drivetrain-chip');
  if (hasPerMotor) { chip.textContent = 'LIVE'; chip.className = 'rl-chip rl-chip-green'; }
  else             { chip.textContent = 'AWAITING PER-MOTOR LOGS'; chip.className = 'rl-chip rl-chip-mut'; }
  if (!hasPerMotor) return;

  const m1 = { a: latest.m1_a, t: latest.m1_t, v: latest.m1_v, c: latest.m1_c, foc: latest.m1_foc };
  const m2 = { a: latest.m2_a, t: latest.m2_t, v: latest.m2_v, c: latest.m2_c, foc: latest.m2_foc };
  setMotor('1', m1, (m1.c ?? 0) > (m2.c ?? 0));
  setMotor('2', m2, (m2.c ?? 0) > (m1.c ?? 0));

  const totalA = (m1.a ?? 0) + (m2.a ?? 0);
  const imbA = (m1.a !== undefined && m2.a !== undefined) ? Math.abs(m1.a - m2.a) : undefined;
  const imbPct = totalA > 0 && imbA !== undefined ? (imbA / (totalA / 2)) * 100 : undefined;
  const imbWarn = (imbA ?? 0) > 12;
  const imbCrit = (imbA ?? 0) > 25;

  const m1Pct = totalA > 0 ? ((m1.a ?? 0) / totalA) * 100 : 50;
  const fill = $('rl-balance-fill');
  fill.style.width = m1Pct.toFixed(1) + '%';
  fill.className = `rl-balance-fill${imbCrit ? ' crit' : imbWarn ? ' warn' : ''}`;

  const delta = $('rl-balance-delta');
  delta.textContent = imbA !== undefined
    ? `Δ ${imbA.toFixed(1)} A${imbPct !== undefined ? ` (${imbPct.toFixed(0)}%)` : ''}`
    : 'Δ — A';
  delta.className = `rl-balance-delta${imbCrit ? ' crit' : imbWarn ? ' warn' : ''}`;

  $('rl-balance-msg').textContent = imbCrit
    ? 'HIGH IMBALANCE — ONE MOTOR/ESC TAKING FAR MORE LOAD. INVESTIGATE AFTER RUN.'
    : imbWarn
      ? 'DRIFTING — SLIGHT IMBALANCE NORMAL UNDER CORNERING / WHEELSPIN. WATCH TEMPS.'
      : 'BALANCED — BOTH MOTORS SHARING LOAD WITHIN EXPECTED RANGE.';
}
function setMotor(n, m, hotter) {
  $(`rl-m${n}-a`).textContent = formatNum(m.a, 1, '--');
  $(`rl-m${n}-t`).textContent = formatNum(m.t, 1, '--');
  $(`rl-m${n}-v`).textContent = formatNum(m.v, 2, '--');
  const cEl = $(`rl-m${n}-c`);
  cEl.textContent = formatNum(m.c, 1, '--');
  cEl.parentElement.className = `tile-val mono${m.c !== undefined && m.c > 60 ? ' warn' : ''}`;
  const focChip = $(`rl-m${n}-foc`);
  if (m.foc === 1) { focChip.textContent = 'FOC'; focChip.className = 'rl-chip rl-chip-green'; }
  else             { focChip.textContent = '—'; focChip.className = 'rl-chip rl-chip-mut'; }
  $(`rl-motor-${n}`).classList.toggle('hotter', hotter);
}

// --- Bus-V sparkline ------------------------------------------------------
function renderBusSparkline() {
  const svg = $('rl-bus-spark');
  const tail = state.samples.slice(-60).map(s => s.bus_v).filter(v => typeof v === 'number');
  if (tail.length < 2) { svg.innerHTML = ''; return; }
  const W = 72, H = 22;
  const min = Math.min(...tail);
  const max = Math.max(...tail);
  const range = Math.max(0.001, max - min);
  const step = W / (tail.length - 1);
  let d = '';
  tail.forEach((v, i) => {
    const x = (i * step).toFixed(1);
    const y = (H - ((v - min) / range) * H).toFixed(1);
    d += `${i === 0 ? 'M' : 'L'} ${x} ${y} `;
  });
  const dipped = tail.some(v => v < 10.5);
  svg.className = `rl-spark${dipped ? ' warn' : ''}`;
  svg.innerHTML = `<path d="${d}" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
}

// --- Event wiring ---------------------------------------------------------
function attach() {
  $('rl-btn-connect').onclick = connect;
  $('rl-btn-disconnect').onclick = disconnect;
  $('rl-btn-mock').onclick = () => state.connection === 'mock' ? stopMock() : startMock();
  $('rl-btn-clear').onclick = clearRun;
  $('rl-btn-export-json').onclick = exportJson;
  $('rl-btn-export-csv').onclick = exportCsv;

  $('rl-btn-csv-choose').onclick = () => $('rl-csv-file').click();
  $('rl-csv-file').onchange = (e) => { const f = e.target.files[0]; if (f) importCsvFromFile(f); e.target.value = ''; };
  $('rl-btn-csv-clear').onclick = clearCsv;

  $('rl-btn-replay-choose').onclick = () => $('rl-replay-file').click();
  $('rl-replay-file').onchange = (e) => { const f = e.target.files[0]; if (f) chooseReplayFile(f); e.target.value = ''; };
  $('rl-btn-replay-start').onclick = startReplay;
  $('rl-btn-replay-stop').onclick = stopReplay;
  document.querySelectorAll('#rl-speed-group .rl-pill').forEach(btn => {
    btn.onclick = () => { state.replaySpeed = Number(btn.dataset.speed); render(); };
  });

  document.querySelectorAll('#rl-filters button').forEach(btn => {
    btn.onclick = () => {
      state.filter = btn.dataset.filter;
      document.querySelectorAll('#rl-filters button').forEach(b => b.classList.toggle('rl-pill-on', b.dataset.filter === state.filter));
      renderEventLog();
    };
  });

  // Signal toggles (delegate, since renderToggles re-creates them)
  $('rl-toggles').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sig]');
    if (!btn) return;
    const k = btn.dataset.sig;
    state.enabledSignals[k] = !state.enabledSignals[k];
    renderToggles();
    renderChart();
  });

  // 250 ms tick to keep last-packet age + stale status fresh
  setInterval(() => render(), 250);
}

// --- Boot -----------------------------------------------------------------
renderToggles();
attach();
render();
