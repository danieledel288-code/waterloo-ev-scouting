import { parseCsvText, parseCsvRow, rebaseTimes, samplesToCsv } from '../race-log/telemetry.js';
import {
  initReveal, applyStagger, countRoll, drawPath, animateScatterPoints, flash,
} from './motion.js';

const STORE_KEY = 'ct-ev-current-limit-runs-v1';
const SEED_VERSION_KEY = 'ct-ev-current-limit-runs-seed-version';
const SEED_VERSION = '20260519-sla-v2-trace';
const SEEDED_RUNS = [
  'race-20260519-211207.csv',
  'race-20260519-212920.csv',
  'race-20260519-213427.csv',
  'race-20260519-213714.csv',
  'race-20260519-213818.csv',
  'race-20260519-214853.csv',
  'race-20260519-215256.csv',
  'race-20260519-215355.csv',
  'race-20260519-215414.csv',
  'race-20260519-220149.csv',
  'race-20260519-222456.csv',
  'race-20260519-224443.csv',
  'race-20260519-231121.csv',
];
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : '—';
const statusFor = (s) => {
  if ((s.minBusV ?? 99) < 9.5) return { kind: 'bad', label: 'LOW BUS' };
  if (s.maxTempC >= 70) return { kind: 'bad', label: 'HOT' };
  if (s.faultRows > 0) return { kind: 'warn', label: `${s.faultRows} FAULT ROWS` };
  return { kind: 'good', label: 'CLEAN' };
};

let filterBattery = 'ALL';
let runs = loadRuns();
let selectedTraceId = null;

function loadRuns() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRuns() {
  localStorage.setItem(STORE_KEY, JSON.stringify(runs));
}

function downsampleSamples(samples, maxPoints = 180) {
  if (!samples.length) return [];
  const step = Math.max(1, Math.ceil(samples.length / maxPoints));
  const t0 = num(samples[0].ts) ?? 0;
  const points = [];
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    points.push({
      t: Math.max(0, (num(s.ts) ?? t0) - t0),
      kph: num(s.kph) ?? 0,
      bus: num(s.bus_v) ?? 0,
      supply: num(s.supply_a) ?? 0,
      stator: num(s.stator_a) ?? 0,
      thr: num(s.thr_pct) ?? 0,
      brk: num(s.brk_pct) ?? 0,
      faults: s.faults?.length ? 1 : 0,
    });
  }
  const last = samples[samples.length - 1];
  const lastT = Math.max(0, (num(last.ts) ?? t0) - t0);
  if (!points.length || points[points.length - 1].t !== lastT) {
    points.push({
      t: lastT,
      kph: num(last.kph) ?? 0,
      bus: num(last.bus_v) ?? 0,
      supply: num(last.supply_a) ?? 0,
      stator: num(last.stator_a) ?? 0,
      thr: num(last.thr_pct) ?? 0,
      brk: num(last.brk_pct) ?? 0,
      faults: last.faults?.length ? 1 : 0,
    });
  }
  return points;
}

function summarizeSamples(samples) {
  let topKph = 0;
  let movingSum = 0;
  let movingCount = 0;
  let maxSupplyA = 0;
  let maxStatorA = 0;
  let minBusV = null;
  let maxTempC = 0;
  let faultRows = 0;
  let distanceKm = 0;
  let netWh = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const kph = num(s.kph);
    const bus = num(s.bus_v);
    const supply = num(s.supply_a);
    const stator = num(s.stator_a);
    const temp = num(s.temp_c);

    if (kph !== undefined) {
      topKph = Math.max(topKph, kph);
      if (kph > 1) {
        movingSum += kph;
        movingCount += 1;
      }
    }
    if (bus !== undefined && bus > 0) minBusV = minBusV === null ? bus : Math.min(minBusV, bus);
    if (supply !== undefined) maxSupplyA = Math.max(maxSupplyA, supply);
    if (stator !== undefined) maxStatorA = Math.max(maxStatorA, stator);
    if (temp !== undefined) maxTempC = Math.max(maxTempC, temp);
    if (s.faults && s.faults.length > 0) faultRows += 1;

    if (i > 0) {
      const prev = samples[i - 1];
      const dtH = Math.max(0, (num(s.ts) - num(prev.ts)) / 3600);
      if (Number.isFinite(dtH) && dtH < 0.01) {
        const prevKph = num(prev.kph) ?? 0;
        const prevBus = num(prev.bus_v) ?? 0;
        const prevSupply = num(prev.supply_a) ?? 0;
        distanceKm += Math.max(0, prevKph) * dtH;
        netWh += prevBus * prevSupply * dtH;
      }
    }
  }

  const avgMovingKph = movingCount ? movingSum / movingCount : 0;
  const last = samples[samples.length - 1] || {};
  const loggedNetWh = num(last.net_wh) ?? num(last.wh);
  const loggedDistanceKm = num(last.distance_km);
  const loggedWhPerKm = num(last.wh_per_km);

  if (loggedNetWh !== undefined) netWh = loggedNetWh;
  if (loggedDistanceKm !== undefined) distanceKm = loggedDistanceKm;
  const whPerKm = loggedWhPerKm !== undefined
    ? loggedWhPerKm
    : distanceKm > 0.01 ? netWh / distanceKm : 0;

  return {
    rows: samples.length,
    topKph,
    avgMovingKph,
    maxSupplyA,
    maxStatorA,
    minBusV,
    maxTempC,
    faultRows,
    distanceKm,
    netWh,
    whPerKm,
  };
}

function num(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

async function importFiles(files) {
  const battery = $('tl-battery').value;
  const supplyLimitA = Number($('tl-supply').value || 0);
  const statorLimitA = Number($('tl-stator').value || 0);
  const labelBase = $('tl-label').value.trim();

  let added = 0;
  for (const file of files) {
    const text = await file.text();
    if (addRunFromText({
      text,
      name: labelBase || file.name.replace(/\.csv$/i, ''),
      filename: file.name,
      battery,
      supplyLimitA,
      statorLimitA,
    })) {
      added += 1;
    }
  }
  $('tl-import-state').textContent = added
    ? `IMPORTED ${added} RUN${added === 1 ? '' : 'S'} AS ${battery} ${supplyLimitA}/${statorLimitA}`
    : 'NO VALID ROWS FOUND';
  saveRuns();
  render();
}

function addRunFromText({ text, name, filename, battery, supplyLimitA, statorLimitA, seeded = false }) {
  const rows = parseCsvText(text);
  const samples = rebaseTimes(rows.map((row, i) => parseCsvRow(row, i)).filter((s) => Number.isFinite(s.ts)));
  if (!samples.length) return false;
  const summary = summarizeSamples(samples);
  const idPrefix = seeded ? `seed-${filename}` : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  runs.push({
    id: idPrefix,
    name,
    filename,
    importedAt: new Date().toISOString(),
    battery,
    supplyLimitA,
    statorLimitA,
    seeded,
    summary,
    trace: downsampleSamples(samples),
  });
  return true;
}

async function loadSeedRuns({ force = false } = {}) {
  const seedCurrent = localStorage.getItem(SEED_VERSION_KEY) === SEED_VERSION;
  if (!force && runs.length && seedCurrent) return;
  if (force || !seedCurrent) {
    runs = runs.filter((r) => !r.seeded);
  }

  let added = 0;
  for (const filename of SEEDED_RUNS) {
    if (runs.some((r) => r.filename === filename && r.seeded)) continue;
    const response = await fetch(`/static/race-testing/sample-data/${filename}`);
    if (!response.ok) continue;
    const text = await response.text();
    const label = filename.replace(/^race-/, 'SLA ').replace(/\.csv$/i, '');
    if (addRunFromText({
      text,
      name: label,
      filename,
      battery: 'SLA',
      supplyLimitA: 40,
      statorLimitA: 120,
      seeded: true,
    })) {
      added += 1;
    }
  }

  if (added || force) {
    localStorage.setItem(SEED_VERSION_KEY, SEED_VERSION);
    $('tl-import-state').textContent = `LOADED ${added} REAL SLA RUN${added === 1 ? '' : 'S'}`;
    saveRuns();
    render();
  }
}

function filteredRuns() {
  return runs.filter((r) => filterBattery === 'ALL' || r.battery === filterBattery);
}

function render() {
  const list = filteredRuns();
  $('tl-count').textContent = `${list.length} RUN${list.length === 1 ? '' : 'S'}`;
  renderRecommendation(list);
  renderSummary(list);
  renderChart(list);
  renderTrace(list);
  renderTable(list);
}

function runScore(run) {
  const s = run.summary;
  if (!s || s.whPerKm <= 0 || s.avgMovingKph <= 0) return -Infinity;
  let score = s.avgMovingKph * 2.2 - s.whPerKm * 1.3;
  if ((s.minBusV ?? 99) < 9.5) score -= 80;
  if (s.maxTempC >= 70) score -= 60;
  score -= Math.min(40, s.faultRows * 0.25);
  if (run.battery === 'MTX') score += 8;
  return score;
}

function renderRecommendation(list) {
  const target = [...list].filter((r) => r.summary.whPerKm > 0 && r.summary.avgMovingKph > 0)
    .sort((a, b) => runScore(b) - runScore(a))[0];
  if (!target) {
    $('tl-recommend').innerHTML = `
      <div class="tl-rec-main">
        <span class="microlabel">RECOMMENDATION</span>
        <strong>IMPORT A RUN</strong>
      </div>
      <p>Once CSVs are loaded, this picks the best speed/efficiency run that avoids ugly voltage, heat, and fault behavior.</p>
    `;
    return;
  }

  const s = target.summary;
  const status = statusFor(s);
  const copy = status.kind === 'good'
    ? 'Clean enough to trust. Use this as the current benchmark.'
    : status.kind === 'warn'
      ? 'Fast data, but warnings mean compare carefully before copying this setup.'
      : 'Do not copy this setup until the safety issue is understood.';
  $('tl-recommend').innerHTML = `
    <div class="tl-rec-main">
      <span class="microlabel">RECOMMENDATION</span>
      <strong>${escapeHtml(target.name)}</strong>
      <small>${target.battery} · ${target.supplyLimitA}/${target.statorLimitA}A · ${fmt(s.avgMovingKph, 1)} avg kph · ${fmt(s.whPerKm, 1)} Wh/km</small>
    </div>
    <span class="tl-status tl-status-${status.kind}">${escapeHtml(status.label)}</span>
    <p>${copy}</p>
  `;
}

function kpiSparkBars(list, accessor, higherIsBetter = true) {
  if (!list.length) return '';
  const vals = list.map(accessor).filter((v) => Number.isFinite(v));
  if (!vals.length) return '';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = (hi - lo) || 1;
  return list.map((r) => {
    const v = accessor(r);
    if (!Number.isFinite(v)) return '<i style="--bar-h:6%"></i>';
    const pct = higherIsBetter
      ? ((v - lo) / range * 100).toFixed(1)
      : ((hi - v) / range * 100).toFixed(1);
    return `<i style="--bar-h:${Math.max(6, Number(pct))}%" title="${escapeHtml(r.name)}"></i>`;
  }).join('');
}

function renderSummary(list) {
  const summaryEl = $('tl-summary');
  if (!summaryEl) return;

  const topKphBest = [...list].sort((a, b) => b.summary.topKph - a.summary.topKph)[0];
  const whBest = [...list].filter((r) => r.summary.whPerKm > 0).sort((a, b) => a.summary.whPerKm - b.summary.whPerKm)[0];
  const sagWorst = [...list].filter((r) => (r.summary.minBusV ?? 99) < 99).sort((a, b) => (a.summary.minBusV ?? 99) - (b.summary.minBusV ?? 99))[0];
  const fastestAvg = [...list].sort((a, b) => b.summary.avgMovingKph - a.summary.avgMovingKph)[0];
  const maxAPeak = list.reduce((m, r) => Math.max(m, r.summary.maxSupplyA || 0), 0);

  const kpis = [
    {
      label: 'TOP KPH',
      val: topKphBest ? topKphBest.summary.topKph : NaN,
      decimals: 1,
      sub: topKphBest ? `${topKphBest.battery} · ${topKphBest.supplyLimitA}/${topKphBest.statorLimitA}A` : 'import runs',
      accent: 'yellow',
      spark: kpiSparkBars(list, (r) => r.summary.topKph),
    },
    {
      label: 'AVG KPH',
      val: fastestAvg ? fastestAvg.summary.avgMovingKph : NaN,
      decimals: 1,
      sub: fastestAvg ? `moving avg · ${fastestAvg.name}` : 'moving avg',
      accent: '',
      spark: kpiSparkBars(list, (r) => r.summary.avgMovingKph),
    },
    {
      label: 'WH/KM',
      val: whBest ? whBest.summary.whPerKm : NaN,
      decimals: 1,
      sub: whBest ? `BEST · ${whBest.name}` : 'no Wh data',
      accent: 'cyan',
      spark: kpiSparkBars(list, (r) => r.summary.whPerKm, false),
    },
    {
      label: 'MIN BUS V',
      val: sagWorst ? sagWorst.summary.minBusV : NaN,
      decimals: 2,
      sub: sagWorst && (sagWorst.summary.minBusV ?? 99) < 9.5 ? 'SAG WARNING' : 'lowest seen',
      accent: sagWorst && (sagWorst.summary.minBusV ?? 99) < 9.5 ? 'red' : '',
      spark: kpiSparkBars(list, (r) => r.summary.minBusV ?? 0, false),
    },
    {
      label: 'MAX A',
      val: maxAPeak || NaN,
      decimals: 1,
      sub: 'supply peak',
      accent: '',
      spark: kpiSparkBars(list, (r) => r.summary.maxSupplyA, false),
    },
    {
      label: 'RUNS',
      val: list.length,
      decimals: 0,
      sub: filterBattery === 'ALL' ? 'all batteries' : filterBattery,
      accent: '',
      spark: '',
    },
  ];

  summaryEl.innerHTML = kpis.map((k) => `
    <div class="tl-kpi fx-rise-in" data-accent="${k.accent}">
      <div class="tl-kpi-head"><span class="microlabel">${k.label}</span></div>
      <strong class="tl-kpi-val fx-count-roll" data-target="${Number.isFinite(k.val) ? k.val : ''}" data-decimals="${k.decimals}">${Number.isFinite(k.val) ? '0' : '—'}</strong>
      <div class="tl-kpi-spark" aria-hidden="true">${k.spark}</div>
      <small class="tl-kpi-sub">${escapeHtml(k.sub)}</small>
    </div>
  `).join('');

  applyStagger(summaryEl, 60);
  // Reveal newly-rendered KPI tiles (they're freshly inserted, so the observer hasn't seen them)
  requestAnimationFrame(() => {
    summaryEl.querySelectorAll('.fx-rise-in').forEach((el) => el.classList.add('is-visible'));
  });
  // Count-roll the numeric tiles
  summaryEl.querySelectorAll('.fx-count-roll').forEach((el) => {
    const target = parseFloat(el.dataset.target);
    if (!Number.isFinite(target)) return;
    const decimals = Number(el.dataset.decimals) || 0;
    countRoll(el, 0, target, 700, decimals);
  });
}

function renderChart(list) {
  const svg = $('tl-chart');
  $('tl-empty').style.display = list.length ? 'none' : '';
  if (!list.length) {
    // Preserve the <defs> block, only nuke the points
    const defs = svg.querySelector('defs');
    svg.innerHTML = defs ? defs.outerHTML : '';
    return;
  }

  const W = 1000, H = 320, P = 46;
  const xs = list.map((r) => r.summary.whPerKm).filter((v) => v > 0);
  const ys = list.map((r) => r.summary.avgMovingKph).filter((v) => v > 0);
  const xMin = Math.max(0, Math.min(...xs, 10) - 2);
  const xMax = Math.max(...xs, 30) + 2;
  const yMin = Math.max(0, Math.min(...ys, 10) - 2);
  const yMax = Math.max(...ys, 35) + 2;
  const xOf = (v) => P + ((v - xMin) / Math.max(1, xMax - xMin)) * (W - P * 2);
  const yOf = (v) => H - P - ((v - yMin) / Math.max(1, yMax - yMin)) * (H - P * 2);

  let out = '';

  // Light grid at 25/50/75%
  for (const pct of [0.25, 0.5, 0.75]) {
    const gx = P + pct * (W - P * 2);
    const gy = P + pct * (H - P * 2);
    out += `<line x1="${gx}" y1="${P}" x2="${gx}" y2="${H - P}" class="tl-grid-line"/>`;
    out += `<line x1="${P}" y1="${gy}" x2="${W - P}" y2="${gy}" class="tl-grid-line"/>`;
  }

  // Crosshair midpoint divider
  const qMidX = P + (W - P * 2) * 0.5;
  const qMidY = P + (H - P * 2) * 0.5;
  out += `<line x1="${qMidX}" y1="${P}" x2="${qMidX}" y2="${H - P}" stroke="#ffffff" stroke-width="1" stroke-dasharray="4 6" opacity="0.06"/>`;
  out += `<line x1="${P}" y1="${qMidY}" x2="${W - P}" y2="${qMidY}" stroke="#ffffff" stroke-width="1" stroke-dasharray="4 6" opacity="0.06"/>`;

  // Quadrant labels
  out += `<text x="${P + 8}"     y="${P + 18}"      text-anchor="start" class="tl-quadrant-label">SLOW · EFFICIENT</text>`;
  out += `<text x="${W - P - 8}" y="${P + 18}"      text-anchor="end"   class="tl-quadrant-label">FAST · EFFICIENT</text>`;
  out += `<text x="${P + 8}"     y="${H - P - 8}"   text-anchor="start" class="tl-quadrant-label">AVOID</text>`;
  out += `<text x="${W - P - 8}" y="${H - P - 8}"   text-anchor="end"   class="tl-quadrant-label">FAST · HUNGRY</text>`;

  out += `<text x="${qMidX}" y="${H - 8}"  text-anchor="middle" class="tl-svg-label">Wh/km</text>`;
  out += `<text x="14"        y="${qMidY}" text-anchor="start"  class="tl-svg-label">avg kph</text>`;

  // Identify podium points
  const byWh = [...list].filter((r) => r.summary.whPerKm > 0).sort((a, b) => a.summary.whPerKm - b.summary.whPerKm);
  const byKph = [...list].sort((a, b) => b.summary.topKph - a.summary.topKph);
  const bestWhId = byWh[0]?.id;
  const bestKphId = byKph[0]?.id;

  for (const r of list) {
    const x = xOf(r.summary.whPerKm || xMax);
    const y = yOf(r.summary.avgMovingKph || 0);
    const bad = (r.summary.minBusV ?? 99) < 9.5 || r.summary.maxTempC >= 70 || r.summary.faultRows > 0;
    const isBestWh = r.id === bestWhId;
    const isBestKph = r.id === bestKphId;
    const fill = isBestWh ? '#faff00'
      : isBestKph ? '#4ad8ff'
      : bad ? '#ff2a1a'
      : r.battery === 'MTX' ? '#2bff8a' : '#a8a39a';
    const filterId = (isBestWh || isBestKph) ? 'tl-glow-strong' : 'tl-glow';
    const rDot = (isBestWh || isBestKph) ? 9 : 6;

    if (isBestWh) {
      out += `<circle cx="${x}" cy="${y}" r="${rDot + 6}" class="tl-pt-ring" fill="none" stroke="#faff00" stroke-width="1.5" opacity="0.55"/>`;
    } else if (isBestKph) {
      out += `<circle cx="${x}" cy="${y}" r="${rDot + 6}" class="tl-pt-ring" fill="none" stroke="#4ad8ff" stroke-width="1.5" opacity="0.55"/>`;
    } else if (bad) {
      out += `<circle cx="${x}" cy="${y}" r="${rDot + 4}" class="tl-pt-ring" fill="none" stroke="#ff2a1a" stroke-width="1.5" opacity="0.45"/>`;
    }

    out += `<circle cx="${x}" cy="${y}" r="${rDot}" fill="${fill}" filter="url(#${filterId})" class="tl-pt-dot" data-id="${escapeHtml(r.id)}"/>`;

    // Label slightly offset
    const label = `${r.supplyLimitA}/${r.statorLimitA} ${r.battery}`;
    out += `<text x="${x + rDot + 5}" y="${y - 6}" class="tl-svg-label" style="opacity:0.55">${escapeHtml(label)}</text>`;
  }

  // Preserve defs node, replace rest
  const defs = svg.querySelector('defs');
  svg.innerHTML = (defs ? defs.outerHTML : '') + out;

  // Wire up the tooltip
  const wrap = svg.parentElement;
  const tip = $('tl-chart-tip');
  svg.querySelectorAll('.tl-pt-dot').forEach((dot) => {
    const run = list.find((r) => r.id === dot.dataset.id);
    if (!run) return;
    dot.addEventListener('mouseenter', () => {
      const s = run.summary;
      tip.innerHTML = `
        <span class="microlabel">${escapeHtml(run.name)}</span>
        <b>${escapeHtml(run.battery)} · ${run.supplyLimitA}/${run.statorLimitA} A</b>
        <span>${fmt(s.avgMovingKph, 1)} avg kph · ${fmt(s.topKph, 1)} top</span>
        <span>${fmt(s.whPerKm, 1)} Wh/km · ${fmt(s.minBusV, 2)} min V</span>
        <span class="muted">${fmt(s.maxSupplyA, 1)} A peak · ${fmt(s.maxTempC, 1)} °C</span>
      `;
      tip.classList.add('is-visible');
      wrap.classList.add('is-hovering');
      dot.classList.add('is-hovered');
    });
    dot.addEventListener('mousemove', (e) => {
      const rect = wrap.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      let left = e.clientX - rect.left + 14;
      let top = e.clientY - rect.top - 12;
      // keep tooltip on-screen
      if (left + tipRect.width > rect.width) left = e.clientX - rect.left - tipRect.width - 14;
      if (top < 0) top = 0;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    });
    dot.addEventListener('mouseleave', () => {
      tip.classList.remove('is-visible');
      wrap.classList.remove('is-hovering');
      dot.classList.remove('is-hovered');
    });
  });

  // Stagger the scatter points in
  animateScatterPoints(svg, 50);
}

function renderTrace(list) {
  const select = $('tl-trace-select');
  const withTrace = list.filter((r) => Array.isArray(r.trace) && r.trace.length > 1);
  $('tl-trace-empty').style.display = withTrace.length ? 'none' : '';
  if (!withTrace.length) {
    select.innerHTML = '<option>No trace data</option>';
    $('tl-trace').innerHTML = '';
    $('tl-trace-stats').innerHTML = '';
    selectedTraceId = null;
    return;
  }

  if (!selectedTraceId || !withTrace.some((r) => r.id === selectedTraceId)) {
    selectedTraceId = [...withTrace].sort((a, b) => runScore(b) - runScore(a))[0].id;
  }

  select.innerHTML = withTrace.map((r) => `
    <option value="${escapeHtml(r.id)}" ${r.id === selectedTraceId ? 'selected' : ''}>
      ${escapeHtml(r.name)} · ${r.battery} · ${r.supplyLimitA}/${r.statorLimitA}A
    </option>
  `).join('');

  const run = withTrace.find((r) => r.id === selectedTraceId) || withTrace[0];
  const trace = run.trace || [];
  const s = run.summary;
  const status = statusFor(s);
  $('tl-trace-stats').innerHTML = [
    ['RUN', run.name],
    ['TOP', `${fmt(s.topKph, 1)} kph`],
    ['AVG', `${fmt(s.avgMovingKph, 1)} kph`],
    ['BUS LOW', `${fmt(s.minBusV, 2)} V`],
    ['MAX A', `${fmt(s.maxSupplyA, 1)} A`],
    ['STATUS', status.label],
  ].map(([k, v]) => `
    <div class="tl-trace-stat ${k === 'STATUS' ? `tl-trace-${status.kind}` : ''}">
      <span>${k}</span>
      <strong>${escapeHtml(v)}</strong>
    </div>
  `).join('');

  // Preserve the <defs> block when replacing trace content
  const svg = $('tl-trace');
  const defs = svg.querySelector('defs');
  svg.innerHTML = (defs ? defs.outerHTML : '') + traceSvg(trace);

  // Draw-in the three traces with a slight stagger
  const paths = svg.querySelectorAll('path.tl-trace-line');
  paths.forEach((p, i) => drawPath(p, 1100, i * 140));

  // Playhead crosshair + floating readout
  const readout = $('tl-trace-readout');
  const wrap = svg.parentElement;
  const hitbox = svg.querySelector('#tl-trace-hitbox');
  const playhead = svg.querySelector('#tl-trace-playhead');
  if (hitbox && playhead && readout) {
    const TRACE_H = 420;
    hitbox.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      // Convert client x to viewBox x (svg uses 1000-wide viewBox)
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const svgX = 46 + ratio * (1000 - 92);
      playhead.setAttribute('x1', svgX);
      playhead.setAttribute('x2', svgX);

      // Find nearest sample by interpolating t from x
      const maxT2 = Math.max(...trace.map((p) => p.t), 1);
      const tAt = ratio * maxT2;
      const closest = trace.reduce((best, p) =>
        Math.abs(p.t - tAt) < Math.abs(best.t - tAt) ? p : best,
        trace[0]);

      readout.innerHTML = `
        <span class="microlabel">t = ${closest.t.toFixed(1)}s</span>
        <span class="row-kph"><b>${fmt(closest.kph, 1)}</b> kph</span>
        <span class="row-bus"><b>${fmt(closest.bus, 2)}</b> V</span>
        <span class="row-amp"><b>${fmt(closest.supply, 1)}</b> A</span>
      `;
      readout.classList.add('is-visible');
      const wrapRect = wrap.getBoundingClientRect();
      const left = e.clientX - wrapRect.left + 14;
      const top = Math.min(wrapRect.height - 100, Math.max(0, e.clientY - wrapRect.top - 20));
      readout.style.left = `${left}px`;
      readout.style.top = `${top}px`;
      void TRACE_H;
    });
    hitbox.addEventListener('mouseleave', () => {
      playhead.setAttribute('x1', -100);
      playhead.setAttribute('x2', -100);
      readout.classList.remove('is-visible');
    });
  }
}

function smoothPath(coords) {
  // Catmull-Rom -> cubic bezier. Produces buttery curves without overshoot.
  if (coords.length < 2) return '';
  let d = `M${coords[0][0].toFixed(1)},${coords[0][1].toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)];
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const p3 = coords[Math.min(coords.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

function traceSvg(trace) {
  const W = 1000, H = 420, P = 46;
  const kphBand = Math.round(H * 0.58);        // top kph band
  const gap = 14;
  const subTop = kphBand + gap;
  const subBand = H - subTop - 18;             // shared bottom band
  const DANGER_V = 9.5;

  const maxT = Math.max(...trace.map((p) => p.t), 1);
  const maxKph = Math.max(...trace.map((p) => p.kph), 35);
  const busVals = trace.map((p) => p.bus).filter((v) => v > 0);
  const minBus = busVals.length ? Math.min(...busVals, 9) : 9;
  const maxBus = busVals.length ? Math.max(...busVals, 15) : 15;
  const maxCurrent = Math.max(...trace.map((p) => Math.abs(p.supply)), 80);

  const xOf = (t) => P + (t / maxT) * (W - P * 2);
  const yKph = (v) => Math.max(8, kphBand - (Math.max(0, v) / maxKph) * (kphBand - 8));
  const busFloor = Math.max(0, minBus - 0.5);
  const busRange = Math.max(1, maxBus - busFloor);
  const yBus = (v) => subTop + (subBand - ((v - busFloor) / busRange) * subBand);
  const yCur = (v) => subTop + (subBand - (Math.abs(v) / maxCurrent) * subBand);

  let out = '';

  // Grid in top band
  for (let i = 1; i < 4; i++) {
    const y = (kphBand / 4) * i;
    out += `<line x1="${P}" y1="${y}" x2="${W - P}" y2="${y}" class="tl-grid-line"/>`;
  }
  // Vertical time grid spans both bands
  for (let i = 1; i < 6; i++) {
    const x = P + i * ((W - P * 2) / 6);
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${H - 18}" class="tl-grid-line"/>`;
  }
  // Divider line between kph and sub bands
  out += `<line x1="${P}" y1="${kphBand + 4}" x2="${W - P}" y2="${kphBand + 4}" stroke="var(--rule-2)" stroke-width="1"/>`;

  // Build kph coords for smoothing
  const kphCoords = trace.map((p) => [xOf(p.t), yKph(p.kph)]);
  const kphD = smoothPath(kphCoords);

  // Gradient area under kph
  if (kphCoords.length >= 2) {
    const firstX = kphCoords[0][0];
    const lastX = kphCoords[kphCoords.length - 1][0];
    out += `<path d="${kphD} L${lastX.toFixed(1)},${kphBand} L${firstX.toFixed(1)},${kphBand} Z" fill="url(#tl-kph-fill)"/>`;
  }

  // Glow shadow under kph
  if (kphD) {
    out += `<path d="${kphD}" stroke="#faff00" stroke-width="5" fill="none" opacity="0.22" filter="url(#tl-tr-glow)"/>`;
    out += `<path d="${kphD}" stroke="#faff00" stroke-width="2.2" fill="none" class="tl-trace-line"/>`;
  }

  // Bus voltage danger fill where bus < DANGER_V
  for (let i = 1; i < trace.length; i++) {
    const prev = trace[i - 1];
    const cur = trace[i];
    const a = prev.bus > 0 ? prev.bus : minBus;
    const b = cur.bus > 0 ? cur.bus : minBus;
    if (a < DANGER_V || b < DANGER_V) {
      const x1 = xOf(prev.t);
      const x2 = xOf(cur.t);
      const topY = subTop;
      out += `<rect x="${x1.toFixed(1)}" y="${topY}" width="${(x2 - x1).toFixed(1)}" height="${subBand}" fill="#ff2a1a" opacity="0.12"/>`;
    }
  }

  // Bus voltage line + danger threshold
  const busCoords = trace.map((p) => [xOf(p.t), yBus(p.bus > 0 ? p.bus : minBus)]);
  const busD = smoothPath(busCoords);
  if (busD) out += `<path d="${busD}" stroke="#4ad8ff" stroke-width="1.6" fill="none" class="tl-trace-line"/>`;

  const dangerY = yBus(DANGER_V);
  if (Number.isFinite(dangerY) && dangerY > subTop && dangerY < subTop + subBand) {
    out += `<line x1="${P}" y1="${dangerY.toFixed(1)}" x2="${W - P}" y2="${dangerY.toFixed(1)}" stroke="#ff2a1a" stroke-width="1" stroke-dasharray="6 4" opacity="0.6"/>`;
    out += `<text x="${W - P - 4}" y="${(dangerY - 3).toFixed(1)}" text-anchor="end" fill="#ff2a1a" font-family="IBM Plex Mono" font-size="9" letter-spacing="0.1em" opacity="0.7">9.5V</text>`;
  }

  // Supply current line
  const curCoords = trace.map((p) => [xOf(p.t), yCur(p.supply)]);
  const curD = smoothPath(curCoords);
  if (curD) out += `<path d="${curD}" stroke="#ffd400" stroke-width="1.4" fill="none" opacity="0.85" class="tl-trace-line"/>`;

  // Fault ticks
  for (const p of trace.filter((pt) => pt.faults)) {
    const x = xOf(p.t);
    out += `<line x1="${x}" y1="0" x2="${x}" y2="${kphBand}" class="tl-trace-fault"/>`;
  }

  // Axis labels
  out += `<text x="${P}" y="${H - 4}" class="tl-svg-label" opacity="0.5">time</text>`;
  out += `<text x="14" y="${kphBand - 4}" class="tl-svg-label" opacity="0.5">kph</text>`;
  out += `<text x="14" y="${subTop + 12}" class="tl-svg-label" opacity="0.5">V / A</text>`;

  // Playhead crosshair (positioned offscreen until hover)
  out += `<line id="tl-trace-playhead" x1="-100" y1="0" x2="-100" y2="${H - 18}" stroke="#a8a39a" stroke-width="1" stroke-dasharray="3 4" opacity="0.55" class="tl-trace-playhead"/>`;
  out += `<rect id="tl-trace-hitbox" x="${P}" y="0" width="${(W - P * 2).toFixed(1)}" height="${(H - 18).toFixed(1)}" fill="transparent" style="cursor:crosshair"/>`;

  return out;
}

function traceMiniBars(trace) {
  if (!Array.isArray(trace) || trace.length < 2) return '';
  const sampleCount = 18;
  const step = Math.max(1, Math.floor(trace.length / sampleCount));
  const kphMax = trace.reduce((m, p) => Math.max(m, p.kph || 0), 1);
  let bars = '';
  for (let i = 0; i < trace.length; i += step) {
    const v = trace[i].kph || 0;
    const pct = Math.max(4, (v / kphMax) * 100).toFixed(0);
    bars += `<i style="--bar-h:${pct}%"></i>`;
  }
  return bars;
}

function renderTable(list) {
  // Rank by Wh/km ascending. Runs without Wh data sink to the bottom.
  const ranked = [
    ...list.filter((r) => r.summary.whPerKm > 0).sort((a, b) => a.summary.whPerKm - b.summary.whPerKm),
    ...list.filter((r) => !(r.summary.whPerKm > 0)),
  ];

  const rankCount = $('tl-rank-count');
  if (rankCount) rankCount.textContent = ranked.length ? `${ranked.length} RANKED` : 'P—';

  const rows = ranked.length ? ranked.map((r, idx) => {
    const s = r.summary;
    const pos = idx + 1;
    const posClass = pos === 1 ? 'tl-pos-gold'
      : pos === 2 ? 'tl-pos-silver'
      : pos === 3 ? 'tl-pos-bronze'
      : '';
    const batClass = r.battery === 'MTX' ? 'is-mtx' : 'is-sla';
    const status = statusFor(s);
    const danger = status.kind === 'bad';
    const bars = traceMiniBars(r.trace);

    return `<tr class="${danger ? 'tl-danger' : ''}">
      <td class="tl-col-pos"><span class="tl-pos-box ${posClass}">P${String(pos).padStart(2, '0')}</span></td>
      <td>
        <span class="tl-bat-bar ${batClass}"></span>
        <b>${escapeHtml(r.name)}</b><br><small>${escapeHtml(r.filename)}</small>
      </td>
      <td>${r.battery}</td>
      <td>${r.supplyLimitA}/${r.statorLimitA} A</td>
      <td>${fmt(s.topKph, 1)}</td>
      <td>${fmt(s.avgMovingKph, 1)}</td>
      <td class="${pos === 1 ? 'tl-cell-best' : ''}">${fmt(s.whPerKm, 1)}</td>
      <td class="${(s.minBusV ?? 99) < 9.5 ? 'tl-cell-warn' : ''}">${fmt(s.minBusV, 2)}</td>
      <td>${fmt(s.maxSupplyA, 1)} / ${fmt(s.maxStatorA, 1)}</td>
      <td class="${s.maxTempC >= 70 ? 'tl-cell-warn' : ''}">${fmt(s.maxTempC, 1)}</td>
      <td>${s.faultRows}</td>
      <td><div class="tl-row-spark ${batClass}" aria-hidden="true">${bars}</div></td>
      <td><span class="tl-status tl-status-${status.kind}">${escapeHtml(status.label)}</span></td>
      <td><button class="tl-x" data-del="${escapeHtml(r.id)}">DEL</button></td>
    </tr>`;
  }).join('') : `<tr><td colspan="14" class="tl-muted">No runs imported yet.</td></tr>`;

  $('tl-body').innerHTML = rows;
  $('tl-run-cards').innerHTML = list.length ? list.map(renderRunCard).join('') : `<div class="tl-run-empty">No runs imported yet.</div>`;
  document.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = () => {
      runs = runs.filter((r) => r.id !== btn.dataset.del);
      saveRuns();
      render();
    };
  });
}

function renderRunCard(r) {
  const s = r.summary;
  const status = statusFor(s);
  return `
    <article class="tl-run-card ${status.kind === 'bad' ? 'tl-run-bad' : ''}">
      <div class="tl-run-card-head">
        <div>
          <strong>${escapeHtml(r.name)}</strong>
          <small>${escapeHtml(r.filename)}</small>
        </div>
        <span class="tl-status tl-status-${status.kind}">${escapeHtml(status.label)}</span>
      </div>
      <div class="tl-run-metrics">
        <span><b>${r.battery}</b><small>battery</small></span>
        <span><b>${r.supplyLimitA}/${r.statorLimitA}A</b><small>limits</small></span>
        <span><b>${fmt(s.topKph, 1)}</b><small>top kph</small></span>
        <span><b>${fmt(s.avgMovingKph, 1)}</b><small>avg kph</small></span>
        <span><b>${fmt(s.whPerKm, 1)}</b><small>Wh/km</small></span>
        <span><b>${fmt(s.minBusV, 2)}</b><small>min bus</small></span>
      </div>
      <button class="tl-x" data-del="${r.id}">DELETE</button>
    </article>
  `;
}

function exportSummary() {
  const cols = ['name','filename','battery','supply_limit_a','stator_limit_a','top_kph','avg_moving_kph','wh_per_km','distance_km','net_wh','min_bus_v','max_supply_a','max_stator_a','max_temp_c','fault_rows','imported_at'];
  const lines = [cols.join(',')];
  for (const r of filteredRuns()) {
    const s = r.summary;
    lines.push([
      r.name, r.filename, r.battery, r.supplyLimitA, r.statorLimitA,
      s.topKph, s.avgMovingKph, s.whPerKm, s.distanceKm, s.netWh,
      s.minBusV ?? '', s.maxSupplyA, s.maxStatorA, s.maxTempC, s.faultRows, r.importedAt,
    ].map(csvEscape).join(','));
  }
  download(new Blob([lines.join('\n')], { type: 'text/csv' }), `current-limit-tests-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

$('tl-choose').onclick = () => $('tl-file').click();
$('tl-file').onchange = (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length) importFiles(files);
  e.target.value = '';
};
$('tl-seed').onclick = () => loadSeedRuns({ force: true });
$('tl-clear').onclick = () => {
  if (!runs.length || confirm('Clear all saved test runs on this laptop?')) {
    runs = [];
    localStorage.removeItem(SEED_VERSION_KEY);
    $('tl-import-state').textContent = 'CLEARED SAVED RUNS';
    saveRuns();
    render();
  }
};
$('tl-export').onclick = exportSummary;
$('tl-trace-select').onchange = (event) => {
  selectedTraceId = event.target.value;
  renderTrace(filteredRuns());
};

document.querySelectorAll('[data-battery]').forEach((btn) => {
  btn.onclick = () => {
    filterBattery = btn.dataset.battery;
    document.querySelectorAll('[data-battery]').forEach((b) => b.classList.toggle('tl-pill-on', b === btn));
    render();
  };
});

// One-time scroll-reveal observer for the static rise-in elements
initReveal();
render();
loadSeedRuns();

// Flash the import-state line whenever it changes, so loaders + clears feel alive.
(function watchImportState() {
  const el = $('tl-import-state');
  if (!el) return;
  let last = el.textContent;
  new MutationObserver(() => {
    if (el.textContent !== last) {
      last = el.textContent;
      flash(el);
    }
  }).observe(el, { childList: true, characterData: true, subtree: true });
})();

// Keep this import used in strict module checks when only summary export exists.
void samplesToCsv;
