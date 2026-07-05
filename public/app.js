'use strict';

const $ = id => document.getElementById(id);
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC_MAP[c]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const FLEET_MS = 5000, TASKS_MS = 30000, INTEL_MS = 60000, SYS_MS = 10000, DIRECTIVE_MS = 60000, NQ_MS = 20000;

let intelData = { activeContext: '', sessionLog: '' };
let activeTab = 'context';
let directive = null;
let lastFleet = [];
let nqState = null;
let tasksState = [];
let fleetCritical = false, fleetDegraded = false;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- text scramble (boot + value changes) ---------- */
const SCRAMBLE_CHARS = '01<>/\\|=+-#@$%&';
const scrTargets = new WeakMap();
function scrambleTo(node, text, dur = 420) {
  try {
    if (!node) return;
    if (REDUCED) { node.textContent = text; return; }
    if (scrTargets.get(node) === text) return;
    scrTargets.set(node, text);
    const start = performance.now();
    (function step(now) {
      if (scrTargets.get(node) !== text) return;
      const p = Math.min(1, (now - start) / dur);
      const keep = Math.floor(text.length * p);
      let out = text.slice(0, keep);
      for (let i = keep; i < text.length; i++) {
        out += text[i] === ' ' ? ' ' : SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
      }
      node.textContent = out;
      if (p < 1) requestAnimationFrame(step);
    })(start);
  } catch (e) { console.error('scramble', e); }
}
function bootFx() {
  try {
    scrambleTo(document.querySelector('.brand h1'), 'SOVEREIGN', 700);
    document.querySelectorAll('.panel-h').forEach((h, i) => {
      const tn = h.childNodes[0];
      if (!tn || tn.nodeType !== 3) return;
      const txt = tn.textContent;
      tn.textContent = '';
      setTimeout(() => scrambleTo(tn, txt, 500), 150 + i * 110);
    });
  } catch (e) { console.error('bootFx', e); }
}

/* ---------- empire orrery: planets = business lanes ---------- */
const orrery = { focus: null, health: {} };
function laneHealth(procs) {
  if (!procs || !procs.length || !lastFleet.length) return null;
  const found = procs.map(n => lastFleet.find(p => p.name === n));
  const down = found.filter(x => !x || x.status !== 'online').length;
  if (down === 0) return 'ok';
  return down < procs.length ? 'warn' : 'crit';
}
const LANES = {
  JUPITER: {
    lane: 'NQ FLEET — TOPSTEP',
    health: () => {
      if (!nqState) return null;
      const v = nqVerdict(nqState);
      return v.cls === 'locked' ? 'crit' : v.cls === 'skip' ? 'warn' : 'ok';
    },
    stats: () => {
      if (!nqState) return [['STATE', 'SYNCING']];
      const v = nqVerdict(nqState);
      const fl = nqState.fleet || [];
      const b = nqState.bias;
      return [
        ['VERDICT', v.text, v.cls === 'locked' ? 'crit' : v.cls === 'skip' ? 'warn' : 'ok'],
        ['BIAS', b && b.composite != null ? String(b.composite) : '—'],
        ['EXPRESS', `${fl.length}/${fl.length} PASSED`],
        ['PRACTICE', nqState.account ? money(nqState.account.balance) + (nqState.account.stateAgeMin > 1560 ? ' STALE' : '') : '—',
          nqState.account && nqState.account.stateAgeMin > 1560 ? 'warn' : ''],
        ['GUARDS', nqState.guards && (nqState.guards.portfolioKill || nqState.guards.circuitTripped) ? 'TRIPPED' : 'CLEAR',
          nqState.guards && (nqState.guards.portfolioKill || nqState.guards.circuitTripped) ? 'crit' : 'ok']
      ];
    }
  },
  EARTH: {
    lane: 'KEYSTONE DIGITAL',
    procs: ['keystone-reply-watch'],
    stats: () => {
      const rw = lastFleet.find(p => p.name === 'keystone-reply-watch');
      const rows = [['REPLY-WATCH', rw && rw.status === 'online' ? 'ONLINE' : 'DOWN', rw && rw.status === 'online' ? 'ok' : 'crit']];
      if (directive && directive.primary) {
        const c = fmtCountdown(directive.primary.deadline);
        rows.push([directive.primary.deadlineLabel || 'METRIC', c.text, c.cls === 'past' ? 'crit' : c.cls === 'close' ? 'warn' : '']);
      }
      const ks = window.keystoneState;
      if (ks) {
        rows.push(['SENT', `${ks.sent} · EV $${ks.evUsd}`]);
        rows.push(['BATCH 07-02', `${ks.batchSent}/${ks.batchTotal} SENT`, ks.batchSent < ks.batchTotal ? 'warn' : 'ok']);
      }
      return rows;
    }
  },
  MERCURY: {
    lane: 'MEME RADAR',
    procs: ['meme-radar-scanner', 'meme-follower', 'meme-followouts', 'meme-hz', 'meme-outcomes', 'meme-pricepath', 'meme-graduates', 'meme-gradouts', 'meme-flowq'],
    stats: () => {
      const procs = LANES.MERCURY.procs;
      const on = procs.filter(n => { const p = lastFleet.find(f => f.name === n); return p && p.status === 'online'; }).length;
      const rows = [['COLLECTORS', `${on}/${procs.length} ONLINE`, on === procs.length ? 'ok' : 'warn']];
      const fq = window.flowqState;
      if (fq) {
        rows.push(['FIRES TODAY', String(fq.firesToday)]);
        if (fq.medBuyers != null) rows.push(['MED BUYERS', String(fq.medBuyers)]);
      }
      return rows;
    }
  },
  MARS: {
    lane: 'TRADELOCKER DESK',
    stats: () => {
      const tl = tasksState.filter(t => /^TL-/.test(t.name));
      const run = tl.filter(t => t.state === 'running').length;
      const rows = [['TL TASKS', `${run}/${tl.length} RUNNING`, run > 0 ? 'ok' : 'warn']];
      const j = window.opsState && window.opsState.journal;
      if (j) rows.push(['GOLD JOURNAL', `${j.gold}/${j.gate} · ${j.open} OPEN`, j.gold >= j.gate ? 'ok' : '']);
      return rows;
    },
    health: () => {
      const tl = tasksState.filter(t => /^TL-/.test(t.name));
      if (!tl.length) return null;
      return tl.some(t => t.state === 'running') ? 'ok' : 'warn';
    }
  },
  VENUS: { lane: 'SOVE SILK', stats: () => [] },
  SATURN: {
    lane: 'REAL ESTATE',
    stats: () => {
      const rows = [];
      const re = window.opsState && window.opsState.re;
      if (re && re.probate != null) rows.push(['PROBATE RAIL', `${re.probate} LEADS · MAIL ONLY`]);
      if (re && re.mailable != null) rows.push(['MAILABLE', `TOP ${re.mailable} READY`]);
      return rows;
    }
  },
  URANUS: {
    lane: 'YOUTUBE AUTOMATION',
    procs: ['mystery-vault-uploader', 'clippyme-backend', 'clippyme-frontend'],
    stats: () => {
      const procs = LANES.URANUS.procs;
      return procs.map(n => {
        const p = lastFleet.find(f => f.name === n);
        return [n.replace(/-/g, ' ').toUpperCase().slice(0, 16), p && p.status === 'online' ? 'ON' : 'OFF', p && p.status === 'online' ? 'ok' : 'warn'];
      });
    }
  },
  NEPTUNE: {
    lane: 'CONSOLE — LYDIA / HUD',
    procs: ['lydia', 'sovereign-hud'],
    stats: () => ['lydia', 'sovereign-hud'].map(n => {
      const p = lastFleet.find(f => f.name === n);
      return [n.toUpperCase(), p && p.status === 'online' ? `ONLINE · R${p.restarts}` : 'DOWN', p && p.status === 'online' ? 'ok' : 'crit'];
    })
  },
  PLUTO: {
    lane: 'AUCTION RADAR',
    procs: ['auction-radar'],
    stats: () => {
      const p = lastFleet.find(f => f.name === 'auction-radar');
      return [['SCANNER', p && p.status === 'online' ? 'ONLINE' : 'DOWN', p && p.status === 'online' ? 'ok' : 'crit']];
    }
  },
  CERES: { lane: 'WAR STORIES', stats: () => [] }
};
function refreshOrrery() {
  try {
    for (const [planet, cfg] of Object.entries(LANES)) {
      orrery.health[planet] = cfg.health ? cfg.health() : laneHealth(cfg.procs);
    }
    if (orrery.focus && !$('lane-card').hidden) showLaneCard(orrery.focus);
  } catch (e) { console.error('orrery', e); }
}
function showLaneCard(name) {
  try {
    const cfg = LANES[name];
    const facts = (directive && directive.laneFacts && directive.laneFacts[name]) || [];
    const rows = [...(cfg && cfg.stats ? cfg.stats() : []), ...facts]
      .map(([k, v, cls]) => `<div class="lane-stat"><span class="k">${esc(k)}</span><span class="v ${cls || ''}">${esc(v)}</span></div>`)
      .join('');
    $('lane-body').innerHTML = `<h3>${esc(name)}</h3><div class="lane-sub">${esc(cfg ? cfg.lane : 'CELESTIAL BODY')}</div>${rows || '<div class="lane-stat"><span class="k">NO LIVE RAIL</span><span class="v">—</span></div>'}`;
    $('lane-card').hidden = false;
  } catch (e) { console.error('laneCard', e); }
}
function hideLaneCard() {
  orrery.focus = null;
  const el = $('lane-card');
  if (el) el.hidden = true;
}
document.addEventListener('DOMContentLoaded', () => {
  const btn = $('lane-close');
  if (btn) btn.addEventListener('click', hideLaneCard);
});

/* ---------- session timeline (futures day, 18:00 ET origin) ---------- */
function renderSessionBar() {
  try {
    const track = $('sb-track');
    if (!track) return;
    const pct = h => (h / 24 * 100).toFixed(2) + '%';
    const bands = [
      { name: 'ASIA', from: 1, to: 10 },
      { name: 'LDN', from: 9, to: 17.5 },
      { name: 'NY', from: 14, to: 23 }
    ];
    let html = bands.map(b =>
      `<div class="sb-band" style="left:${pct(b.from)};width:${pct(b.to - b.from)}"></div>` +
      `<span class="sb-label" style="left:${pct(b.from)}">${b.name}</span>`).join('');
    html += `<div class="sb-band rth" style="left:${pct(15.5)};width:${pct(6.5)}"></div>`;
    html += `<div class="sb-mark" style="left:${pct(15 + 25 / 60)}" title="9:25 bot boot"></div>`;
    html += `<div class="sb-now" id="sb-now"></div>`;
    track.innerHTML = html;
    updateSessionNow();
  } catch (e) { console.error('sessionBar', e); }
}
function updateSessionNow() {
  try {
    const el = $('sb-now');
    if (!el) return;
    const parts = Object.fromEntries(etFmt.formatToParts(new Date()).map(p => [p.type, p.value]));
    const mins = (+parts.hour) * 60 + (+parts.minute);
    const since18 = ((mins - 18 * 60) + 1440) % 1440;
    el.style.left = (since18 / 1440 * 100).toFixed(2) + '%';
  } catch (e) { console.error('sessionNow', e); }
}
setInterval(updateSessionNow, 30000);

/* ---------- econ chips ---------- */
function renderEconChips() {
  try {
    const el = $('econ-chips');
    if (!el || !nqState || !nqState.econ) return;
    const ev = nqState.econ.events || [];
    let html;
    if (ev.length) {
      html = ev.map(e => {
        const c = fmtCountdown(e.ts);
        return `<span class="chip ${e.impact === 'HIGH' ? 'high' : ''}">${esc(e.category)} <b>${c.text}</b></span>`;
      }).join('');
    } else {
      const last = nqState.econ.lastPast;
      html = `<span class="chip stale">ECON CAL STALE${last ? ' · LAST ' + new Date(last).toISOString().slice(5, 10) : ''} — REFILL nq-bot/data/econ_calendar.json</span>`;
    }
    el.innerHTML = html;
    el.hidden = false;
  } catch (e) { console.error('econ', e); }
}
setInterval(renderEconChips, 60000);

/* ---------- sparklines ---------- */
function drawSpark(id, arr, fixedMax) {
  try {
    const c = $(id);
    if (!c || !arr || arr.length < 2) return;
    const d = devicePixelRatio || 1;
    const w = c.clientWidth * d, h = c.clientHeight * d;
    if (!w || !h) return;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const min = fixedMax == null ? Math.min(...arr) : 0;
    const max = fixedMax == null ? Math.max(...arr) : fixedMax;
    const span = (max - min) || 1;
    g.strokeStyle = 'rgba(178,219,143,0.65)';
    g.lineWidth = d;
    g.beginPath();
    arr.forEach((v, i) => {
      const x = i / (arr.length - 1) * (w - 2) + 1;
      const y = h - 2 - (v - min) / span * (h - 4);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    g.fillStyle = 'rgba(211,245,176,0.9)';
    const lv = arr[arr.length - 1];
    g.fillRect(w - 3, h - 2 - (lv - min) / span * (h - 4) - 1, 2.4 * d, 2.4 * d);
  } catch (e) { console.error('drawSpark', e); }
}
async function loadSpark() {
  try {
    const s = await getJson('/api/spark');
    drawSpark('spark-mem', s.mem, 100);
    drawSpark('spark-restarts', s.restarts, null);
    drawSpark('spark-flow', s.flow, null);
  } catch (e) { console.error('spark', e); }
}

/* core visual state — consumed by the canvas loop */
const RGB = { ok: [178, 219, 143], warn: [219, 179, 95], crit: [217, 122, 108] };
const coreState = {
  rgb: [...RGB.ok], target: [...RGB.ok],
  bias: null, skipTh: -0.5, upTh: 0.2
};

/* ---------- clock + ET session ---------- */
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  weekday: 'short', hour: '2-digit', minute: '2-digit'
});
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
function etSessionLine() {
  const parts = Object.fromEntries(etFmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const hm = `${parts.hour}:${parts.minute}`;
  const mins = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  const isWeekday = WEEKDAYS.includes(parts.weekday);
  const BOOT = 9 * 60 + 25, OPEN = 9 * 60 + 30, CLOSE = 16 * 60;
  let session;
  if (isWeekday && mins >= BOOT && mins < OPEN) session = 'BOOT LIVE';
  else if (isWeekday && mins >= OPEN && mins < CLOSE) session = 'RTH OPEN';
  else {
    let daysAhead = 0, dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    if (!isWeekday || mins >= BOOT) {
      daysAhead = 1;
      while (![1, 2, 3, 4, 5].includes((dayIdx + daysAhead) % 7)) daysAhead++;
    }
    const total = daysAhead * 1440 + BOOT - mins;
    const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
    session = 'BOOT ' + (d > 0 ? `${d}D ${h}H` : h > 0 ? `${h}H ${m}M` : `${m}M`);
  }
  return `ET ${hm} · ${session}`;
}
function tickClock() {
  try {
    const n = new Date();
    $('clock-time').textContent = n.toLocaleTimeString('en-US', { hour12: false });
    $('clock-date').textContent = n.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' }).toUpperCase();
    $('clock-market').textContent = etSessionLine();
  } catch (e) { console.error('clock', e); }
}
setInterval(tickClock, 1000); tickClock();

/* ---------- fetch helper ---------- */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

/* ---------- defcon (room-wide state) ---------- */
function applyDefcon() {
  try {
    const g = nqState && nqState.guards;
    // room tint follows the same served verdict as the badge — no second rule copy
    const v = nqState ? nqVerdict(nqState) : null;
    const crit = fleetCritical || (v && v.cls === 'locked');
    const warn = fleetDegraded || (v && v.cls === 'skip') || (g && g.paused.length > 0);
    const level = crit ? 'crit' : warn ? 'warn' : 'ok';
    document.body.classList.toggle('defcon-crit', level === 'crit');
    document.body.classList.toggle('defcon-warn', level === 'warn');
    coreState.target = [...RGB[level === 'ok' ? 'ok' : level]];
  } catch (e) { console.error('defcon', e); }
}

/* ---------- NQ desk ---------- */
const money = v => '$' + Math.round(v).toLocaleString('en-US');
function nqVerdict(d) {
  // server's verdict.js is the ONLY evaluator — /api/nq always carries it
  return (d && d.verdict && d.verdict.text) ? d.verdict : { text: 'NO BIAS', cls: 'skip' };
}
function topComponents(components, n) {
  return Object.entries(components || {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, n)
    .map(([k, v], i) => {
      const name = esc(k.split('.').pop());
      const val = (v > 0 ? '+' : '') + v;
      return i === 0 ? `<b>${name} ${val}</b>` : `${name} ${val}`;
    })
    .join(' · ');
}
function agoMin(m) {
  if (m == null) return '—';
  if (m < 1) return 'NOW';
  if (m < 60) return `${Math.round(m)}M AGO`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}H AGO` : `${Math.floor(h / 24)}D AGO`;
}
const num = v => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));
function normalizeNq(d) {
  // coerce every numeric field once — templates interpolate these raw
  if (d.account) {
    for (const k of ['balance', 'realized', 'openSize', 'stateAgeMin']) d.account[k] = num(d.account[k]) ?? 0;
  }
  if (d.bias) {
    d.bias.composite = num(d.bias.composite);
    d.bias.skipThreshold = num(d.bias.skipThreshold) ?? -0.5;
    d.bias.upsizeThreshold = num(d.bias.upsizeThreshold) ?? 0.2;
    if (d.bias.components) {
      for (const k of Object.keys(d.bias.components)) d.bias.components[k] = num(d.bias.components[k]) ?? 0;
    }
  }
  if (d.pulse) {
    d.pulse.stratLogAgeMin = num(d.pulse.stratLogAgeMin);
    d.pulse.schedulerAgeMin = num(d.pulse.schedulerAgeMin);
  }
  if (Array.isArray(d.fleet)) {
    for (const f of d.fleet) {
      for (const k of ['balance', 'hwm', 'blind', 'guardAgeMin']) f[k] = num(f[k]);
    }
  }
  return d;
}
async function loadNq() {
  try {
    const d = normalizeNq(await getJson('/api/nq'));
    nqState = d;
    const v = nqVerdict(d);
    coreState.bias = d.bias ? d.bias.composite : null;
    coreState.skipTh = d.bias ? (d.bias.skipThreshold ?? -0.5) : -0.5;
    coreState.upTh = d.bias ? d.bias.upsizeThreshold : 0.2;

    const a = d.account;
    const g = d.guards;
    const pnlCls = a && a.realized >= 0 ? 'up' : 'dn';
    const pills = g ? [
      `<span class="pill ${g.portfolioKill ? 'bad' : 'ok'}">KILL ${g.portfolioKill ? 'ACTIVE' : 'OFF'}</span>`,
      `<span class="pill ${g.circuitTripped ? 'bad' : 'ok'}">CIRCUIT ${g.circuitTripped ? 'TRIPPED' : 'OK'}</span>`,
      `<span class="pill ${g.paused.length ? 'warn' : 'ok'}">PAUSED ${g.paused.length}</span>`,
      a ? `<span class="pill ${a.lockState === 'open' ? 'ok' : 'bad'}">ACCT ${esc((a.lockState || '?').toUpperCase())}</span>` : ''
    ].join('') : '';

    const fleet = Array.isArray(d.fleet) ? d.fleet : [];
    const funded = fleet.filter(f => f.balance > 0);
    const fleetTotal = funded.reduce((s, f) => s + f.balance, 0);
    // headline = express money once activated; until then express status leads
    const headline = funded.length > 0
      ? `<div class="nq-meta">EXPRESS FLEET · ${funded.length}/${fleet.length} FUNDED</div>
         <div class="nq-balance"><span class="amt">${money(fleetTotal)}</span></div>`
      : `<div class="nq-meta">EXPRESS FLEET · ${fleet.length}/${fleet.length} PASSED · AWAITING BIG-BANG</div>`;
    // practice sim is a footnote; STALE tag when its state stops updating (>26h)
    const practiceStale = a && a.stateAgeMin > 1560;
    const practiceRow = a ? `
      <div class="nq-row" style="margin-top:6px">
        <span class="k">PRACTICE · SIM${practiceStale ? ` · <b class="stale">STALE ${Math.round(a.stateAgeMin / 60)}H</b>` : ''}</span>
        <span class="v">${money(a.balance)} <span class="${pnlCls}">${a.realized >= 0 ? '+' : '−'}${money(Math.abs(a.realized))}</span></span>
      </div>` : '';

    $('nq').innerHTML = `
      ${headline}
      ${renderFleetRows(fleet)}
      ${practiceRow}
      <div class="nq-row">
        <span class="k">BIAS ${d.bias ? esc(d.bias.asof || '') : ''}</span>
        <span class="v">${d.bias && d.bias.composite != null ? `${d.bias.composite > 0 ? '+' : ''}${d.bias.composite} / skip ≤ ${d.bias.skipThreshold}` : '—'}</span>
      </div>
      <div><span class="nq-verdict ${v.cls}">${v.text}</span></div>
      ${d.bias && d.bias.components ? `<div class="nq-why">${topComponents(d.bias.components, 3)}</div>` : ''}
      <div class="nq-pills">${pills}</div>
      <div class="nq-row"><span class="k">STRAT LOG</span><span class="v">${d.pulse.stratLogAgeMin == null ? 'NONE TODAY' : esc(agoMin(d.pulse.stratLogAgeMin))}</span></div>
      ${a && a.openSize > 0 ? `<div class="nq-row"><span class="k">OPEN POS</span><span class="v">${esc(String(a.openSide || ''))} × ${a.openSize}</span></div>` : ''}
      <div class="nq-meta">SNAPSHOT ${esc(agoMin(a ? a.stateAgeMin : null))} · POLL ${NQ_MS / 1000}S</div>`;

    renderCoreStrip();
    applyDefcon();
    renderAlerts(lastFleet);
    buildTicker();
    renderEconChips();
    refreshOrrery();
  } catch (e) {
    console.error('nq', e);
    $('nq').innerHTML = '<div class="err">NQ LINK DOWN — retrying</div>';
  }
}

function renderFleetRows(fleet) {
  if (!Array.isArray(fleet) || fleet.length === 0) return '';
  const rows = fleet.map(f => {
    let dot, status;
    if (f.fired) { dot = 'dot-crit'; status = 'FLATTENED'; }
    else if (f.disabled) { dot = 'dot-off'; status = 'GUARD OFF'; }
    else if (f.guardAgeMin == null) { dot = 'dot-off'; status = 'NO GUARD'; }
    else if (f.guardAgeMin > 10) { dot = 'dot-warn'; status = `GUARD ${esc(agoMin(f.guardAgeMin))}`; }
    else { dot = 'dot-ok'; status = `GUARD ${esc(agoMin(f.guardAgeMin))}`; }
    const bal = f.balance > 0 ? money(f.balance) : 'PASSED';
    return `<div class="facct">
      <span class="dot ${dot}"></span>
      <span class="lbl">${esc(f.label)}</span>
      <span class="id">${esc(f.account)}</span>
      <span class="bal${f.balance > 0 ? ' live' : ''}">${bal}</span>
      <span class="gs">${status}</span>
    </div>`;
  }).join('');
  return rows;
}

function renderCoreStrip() {
  try {
    const el = $('core-strip');
    if (!nqState) { el.hidden = true; return; }
    const a = nqState.account, b = nqState.bias, v = nqVerdict(nqState);
    const bits = [];
    const fl = Array.isArray(nqState.fleet) ? nqState.fleet : [];
    const fn = fl.filter(f => f.balance > 0);
    if (fl.length) bits.push(fn.length > 0
      ? `EXPRESS <b>${money(fn.reduce((s, f) => s + f.balance, 0))}</b> (${fn.length}/${fl.length})`
      : `EXPRESS <b>${fl.length}/${fl.length} PASSED</b>`);
    if (a) bits.push(a.stateAgeMin > 1560
      ? `SIM <span class="skip">${money(a.balance)} STALE</span>`
      : `SIM <b>${money(a.balance)}</b>`);
    if (b && b.composite != null) {
      const cls = v.cls === 'locked' ? 'crit' : v.cls === 'skip' ? 'skip' : '';
      bits.push(`BIAS <span class="${cls}">${b.composite > 0 ? '+' : ''}${b.composite} ${v.text}</span>`);
    }
    const g = nqState.guards;
    if (g) bits.push(g.portfolioKill || g.circuitTripped
      ? `<span class="crit">GUARDS TRIPPED</span>`
      : g.paused.length ? `<span class="skip">${g.paused.length} PAUSED</span>` : 'GUARDS CLEAR');
    el.innerHTML = bits.map(x => `<span>${x}</span>`).join('');
    el.hidden = false;
  } catch (e) { console.error('coreStrip', e); }
}

/* ---------- fleet ---------- */
function fmtUptime(ms) {
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return Math.floor(h / 24) + 'd';
  if (h >= 1) return h + 'h';
  return Math.max(1, Math.floor(ms / 60000)) + 'm';
}

async function loadFleet() {
  try {
    const fleet = await getJson('/api/fleet');
    lastFleet = fleet;
    const expectedStopped = ((directive && directive.watchlist) || [])
      .filter(w => w.expect === 'stopped').map(w => w.process);
    const healthy = fleet.filter(p =>
      p.status === 'online' || (p.status === 'stopped' && expectedStopped.includes(p.name))).length;
    const online = fleet.filter(p => p.status === 'online').length;
    fleetDegraded = fleet.length > 0 && healthy < fleet.length;
    scrambleTo($('fleet-count'), `${online}/${fleet.length}`);
    $('core-status').innerHTML = fleet.length === 0
      ? '<span class="dot dot-warn"></span>NO PROCS'
      : healthy === fleet.length
        ? '<span class="dot dot-ok"></span>NOMINAL'
        : '<span class="dot dot-warn"></span>DEGRADED';

    $('fleet').innerHTML = fleet.length === 0
      ? '<div class="empty">no pm2 processes — pm2 start to populate</div>'
      : fleet.map(p => {
          const isParked = p.status === 'stopped' && expectedStopped.includes(p.name);
          const dot = p.status === 'online' ? 'dot-ok' : isParked ? 'dot-off' : 'dot-crit';
          const hot = p.restarts > threshold('restartHot', 5) ? ' hot' : '';
          return `<div class="proc">
            <span class="dot ${dot}"></span>
            <span class="nm">${esc(p.name)}</span>
            <span class="cpu">${p.cpu}% · ${p.memMb}M · ${fmtUptime(p.uptimeMs)}</span>
            <span class="rst${hot}">R${p.restarts}</span>
          </div>`;
        }).join('');

    renderAlerts(fleet);
    applyDefcon();
    refreshOrrery();
  } catch (e) {
    console.error('fleet', e);
    $('fleet').innerHTML = '<div class="err">FLEET LINK DOWN — retrying</div>';
    $('core-status').innerHTML = '<span class="dot dot-crit"></span>NO LINK';
  }
}

/* ---------- alerts (watchlist rules + NQ guards) ---------- */
function renderAlerts(fleet) {
  try {
    const alerts = [];
    for (const w of (directive && directive.watchlist) || []) {
      const p = fleet.find(f => f.name === w.process);
      if (w.expect === 'stopped' && p && p.status === 'online') {
        alerts.push({ msg: `${w.process} is ONLINE but expected STOPPED — ${w.reason}`, crit: true });
      }
      if (w.expect === 'online' && (!p || p.status !== 'online')) {
        alerts.push({ msg: `${w.process} is DOWN but expected ONLINE — ${w.reason}`, crit: true });
      }
    }
    fleetCritical = alerts.some(a => a.crit);
    for (const p of fleet) {
      if (p.status === 'online' && p.restarts > threshold('restartAlert', 8)) {
        alerts.push({ msg: `${p.name} restart count ${p.restarts} — check logs`, crit: false });
      }
    }
    if (nqState && nqState.guards) {
      const g = nqState.guards;
      if (g.portfolioKill) alerts.push({ msg: `NQ PORTFOLIO KILL ACTIVE — ${g.killReason || 'manual override'}`, crit: true });
      if (g.circuitTripped) alerts.push({ msg: `NQ CIRCUIT TRIPPED — ${g.tripReason || 'see circuit_state.json'}`, crit: true });
      if (nqState.account && nqState.account.lockState && nqState.account.lockState !== 'open') {
        alerts.push({ msg: `NQ ACCOUNT ${nqState.account.lockState.toUpperCase()} — ${nqState.account.lockReason || 'see limits state'}`, crit: true });
      }
    }
    const el = $('alerts');
    if (alerts.length === 0) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = alerts.map(a => `<div class="alert${a.crit ? ' crit' : ''}">${esc(a.msg)}</div>`).join('');
  } catch (e) { console.error('alerts', e); }
}

/* ---------- shared feed helpers (flowq + keystone panels use these) ---------- */
const shortAddr = a => a.slice(0, 4) + '…' + a.slice(-4);
function agoFmt(t) {
  const m = Math.floor((Date.now() - Date.parse(t)) / 60000);
  if (m < 1) return 'NOW';
  if (m < 60) return m + 'M';
  const h = Math.floor(m / 60);
  return h < 48 ? h + 'H' : Math.floor(h / 24) + 'D';
}
/* ---------- system (topbar stat) ---------- */
async function loadSystem() {
  try {
    const s = await getJson('/api/system');
    const upH = Math.floor(s.uptimeSec / 3600);
    const up = upH >= 24 ? Math.floor(upH / 24) + 'd' : upH + 'h';
    scrambleTo($('host-stat'), `MEM ${s.memUsedPct}% · UP ${up}`);
  } catch (e) {
    console.error('system', e);
    $('host-stat').textContent = 'NO VITALS';
  }
}

/* ---------- scheduled tasks ---------- */
async function loadTasks() {
  try {
    const tasks = await getJson('/api/tasks');
    tasksState = tasks;
    const running = tasks.filter(t => t.state === 'running').length;
    scrambleTo($('task-count'), `${running} LIVE / ${tasks.length}`);
    refreshOrrery();
    $('tasks').innerHTML = tasks.length === 0
      ? '<div class="empty">no matching scheduled tasks</div>'
      : tasks.map(t =>
          `<div class="task ${t.state}">
            <span class="dot"></span>
            <span class="nm">${esc(t.name)}</span>
            <span class="st">${t.state.toUpperCase()}</span>
          </div>`).join('');
  } catch (e) {
    console.error('tasks', e);
    $('tasks').innerHTML = '<div class="err">TASK LINK DOWN — retrying</div>';
  }
}

/* ---------- intel ---------- */
function stripMd(t) {
  return t.replace(/^#{1,6}\s*/gm, '').replace(/\*\*|__|\[\[|\]\]/g, '').replace(/^>\s*/gm, '');
}
function renderIntel() {
  try {
    $('intel').textContent = stripMd(activeTab === 'context' ? intelData.activeContext : intelData.sessionLog) || 'empty';
  } catch (e) { console.error('renderIntel', e); }
}
async function loadIntel() {
  try {
    intelData = await getJson('/api/intel');
    renderIntel();
  } catch (e) {
    console.error('intel', e);
    $('intel').textContent = 'OBSIDIAN LINK DOWN — retrying';
  }
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  activeTab = b.dataset.tab;
  renderIntel();
}));

/* ---------- directive + countdowns ---------- */
function fmtCountdown(deadline) {
  const diff = new Date(deadline) - Date.now();
  if (diff <= 0) return { text: 'ELAPSED', cls: 'past' };
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const text = d > 0 ? `${d}D ${h}H` : `${h}H ${m}M`;
  return { text, cls: diff < 86400000 ? 'close' : '' };
}

const threshold = (key, fallback) =>
  (directive && directive.thresholds && directive.thresholds[key]) ?? fallback;
async function loadDirective() {
  try {
    directive = await getJson('/api/directive');
    $('directive-label').textContent = directive.primary.label;
    scrambleTo($('directive-value'), directive.primary.value, 700);
    renderCountdowns();
  } catch (e) {
    console.error('directive', e);
    $('directive-value').textContent = 'DIRECTIVE LINK DOWN';
  }
}
function renderCountdowns() {
  try {
    if (!directive) return;
    const items = [{ label: directive.primary.deadlineLabel, deadline: directive.primary.deadline }, ...(directive.secondary || [])];
    $('countdowns').innerHTML = items.map(i => {
      const c = fmtCountdown(i.deadline);
      return `<div class="cd"><span class="k">${esc(i.label)}</span><span class="v ${c.cls}">${c.text}</span></div>`;
    }).join('');
  } catch (e) { console.error('countdowns', e); }
}
setInterval(renderCountdowns, 30000);

/* ---------- ticker (live values, rebuilt on data refresh) ---------- */
function buildTicker() {
  try {
    const msgs = ['SOVEREIGN HUD ONLINE'];
    if (nqState && Array.isArray(nqState.fleet) && nqState.fleet.length) {
      const fn = nqState.fleet.filter(f => f.balance > 0);
      msgs.push(fn.length > 0
        ? `EXPRESS FLEET <b>${money(fn.reduce((s, f) => s + f.balance, 0))} · ${fn.length}/${nqState.fleet.length} FUNDED</b>`
        : `EXPRESS FLEET <b>${nqState.fleet.length}/${nqState.fleet.length} PASSED · AWAITING BIG-BANG</b>`);
    }
    if (nqState && nqState.account) {
      msgs.push(`PRACTICE <b>${money(nqState.account.balance)}${nqState.account.stateAgeMin > 1560 ? ' (STALE)' : ''}</b>`);
    }
    if (nqState && nqState.bias && nqState.bias.composite != null) {
      msgs.push(`BIAS <b>${nqState.bias.composite > 0 ? '+' : ''}${nqState.bias.composite} ${nqVerdict(nqState).text}</b>`);
    }
    if (lastFleet.length) {
      msgs.push(`FLEET <b>${lastFleet.filter(p => p.status === 'online').length}/${lastFleet.length} ONLINE</b>`);
    }
    const ks = window.keystoneState;
    if (ks) msgs.push(`KEYSTONE <b>${ks.sent} SENT · EV $${ks.evUsd}</b>`);
    const fq = window.flowqState;
    if (fq) msgs.push(`MEME FLOW <b>${fq.firesToday} FIRES TODAY</b>`);
    const j = window.opsState && window.opsState.journal;
    if (j) msgs.push(`GOLD JOURNAL <b>${j.gold}/${j.gate}</b>`);
    const tp = window.tapeState && window.tapeState.events && window.tapeState.events[0];
    if (tp) msgs.push(`TAPE <b>${esc(tp.msg)}</b>`);
    msgs.push('FREEDOM > ALL', 'EVERY ANALYSIS ENDS IN A WRITTEN VERDICT');
    const half = msgs.map(m => `<span>${m}&nbsp;&nbsp;//&nbsp;&nbsp;</span>`).join('');
    $('ticker').innerHTML = half + half;
  } catch (e) { console.error('ticker', e); }
}
buildTicker();

/* ---------- solar system core (vanilla canvas, zoom + pan) ---------- */
function initSolarSystem() {
  const canvas = $('core-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = devicePixelRatio || 1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TAU = Math.PI * 2;
  const EARTH_ORBIT_S = 90;               // one Earth year every 90 real seconds
  const SPEED = 365.25 / EARTH_ORBIT_S;   // sim days per real second

  // real mean longitudes at J2000 -> planets sit where they actually are today.
  // orbit spacing = sqrt(AU) so the outer system stays on screen; sizes stylized.
  const J2000 = Date.UTC(2000, 0, 1, 12);
  const PLANETS = [
    { name: 'MERCURY', au: 0.39, period: 87.97, L0: 252.25, r: 2.1, color: '#9c9484', craters: true,
      info: '0.39 AU · 88D · 4,879 KM' },
    { name: 'VENUS', au: 0.72, period: 224.7, L0: 181.98, r: 3.2, color: '#d9b98a', swirls: true,
      halo: 'rgba(217,185,138,0.3)', info: '0.72 AU · 225D · 12,104 KM' },
    { name: 'EARTH', au: 1.0, period: 365.25, L0: 100.46, r: 3.4, color: '#5f93cf', earth: true,
      halo: 'rgba(111,159,216,0.35)', info: '1.00 AU · 365D · 12,742 KM',
      moons: [{ name: 'MOON', dist: 9, period: 27.32, r: 1.1, color: '#b8b4a8' }] },
    { name: 'MARS', au: 1.52, period: 687, L0: 355.45, r: 2.7, color: '#c47a58', mars: true,
      info: '1.52 AU · 687D · 6,779 KM',
      moons: [
        { name: 'PHOBOS', dist: 6, period: 0.319, r: 0.6, color: '#9c8878' },
        { name: 'DEIMOS', dist: 9, period: 1.263, r: 0.5, color: '#8c7c6c' }
      ] },
    { name: 'CERES', au: 2.77, period: 1682, L0: 291.4, r: 1.1, color: '#8f8a7c', dwarf: true,
      info: '2.77 AU · 4.6Y · DWARF' },
    { name: 'JUPITER', au: 5.2, period: 4333, L0: 34.40, r: 8.5, color: '#cfa87e', bands: true, spot: true,
      halo: 'rgba(207,168,126,0.2)', info: '5.20 AU · 11.9Y · 139,820 KM',
      moons: [
        { name: 'IO', dist: 13, period: 1.77, r: 1.0, color: '#d4c069' },
        { name: 'EUROPA', dist: 16, period: 3.55, r: 0.9, color: '#c8beb0' },
        { name: 'GANYMEDE', dist: 19, period: 7.15, r: 1.3, color: '#a89c8c' },
        { name: 'CALLISTO', dist: 23, period: 16.69, r: 1.2, color: '#8c8478' }
      ] },
    { name: 'SATURN', au: 9.58, period: 10759, L0: 49.94, r: 7.2, color: '#d8c49a', rings: true,
      info: '9.58 AU · 29.5Y · 116,460 KM',
      moons: [
        { name: 'ENCELADUS', dist: 13, period: 1.37, r: 0.6, color: '#dcd8d0' },
        { name: 'RHEA', dist: 16, period: 4.52, r: 0.8, color: '#b0a898' },
        { name: 'TITAN', dist: 21, period: 15.95, r: 1.3, color: '#c9a25e' }
      ] },
    { name: 'URANUS', au: 19.2, period: 30687, L0: 313.23, r: 5.0, color: '#9fd4d4', vring: true,
      halo: 'rgba(159,212,212,0.18)', info: '19.2 AU · 84Y · 50,724 KM',
      moons: [{ name: 'TITANIA', dist: 12, period: 8.71, r: 0.8, color: '#a8a098' }] },
    { name: 'NEPTUNE', au: 30.05, period: 60190, L0: 304.88, r: 4.9, color: '#7a9fe0',
      halo: 'rgba(122,159,224,0.2)', info: '30.1 AU · 165Y · 49,244 KM',
      moons: [{ name: 'TRITON', dist: 12, period: -5.88, r: 0.9, color: '#c0b8ac' }] },
    { name: 'PLUTO', au: 39.5, period: 90560, L0: 238.93, r: 1.6, color: '#b8a49a', dwarf: true,
      info: '39.5 AU · 248Y · DWARF',
      moons: [{ name: 'CHARON', dist: 6, period: 6.39, r: 0.8, color: '#948a80' }] }
  ];
  const MAX_SQRT = Math.sqrt(39.5);
  const hexRgb = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  for (const p of PLANETS) {
    p.dist = Math.sqrt(p.au) / MAX_SQRT;
    const rgb = hexRgb(p.color);
    p.light = `rgb(${rgb.map(c => clamp(Math.round(c + (255 - c) * 0.45), 0, 255)).join(',')})`;
    p.dark = `rgb(${rgb.map(c => Math.round(c * 0.35)).join(',')})`;
  }

  // Halley's comet: real eccentric orbit, perihelion 1986-02-09
  const HALLEY = { a: 17.83, e: 0.967, period: 27759, periMs: Date.UTC(1986, 1, 9), rot: 1.95 };
  function halleyWorld(simDaysFromNow) {
    const daysSincePeri = (Date.now() - HALLEY.periMs) / 86400000 + simDaysFromNow;
    const M = ((daysSincePeri / HALLEY.period) % 1) * TAU;
    let E = M;
    for (let i = 0; i < 8; i++) E = E - (E - HALLEY.e * Math.sin(E) - M) / (1 - HALLEY.e * Math.cos(E));
    const rAu = HALLEY.a * (1 - HALLEY.e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + HALLEY.e) * Math.sin(E / 2), Math.sqrt(1 - HALLEY.e) * Math.cos(E / 2));
    const wd = Math.sqrt(rAu) / MAX_SQRT;
    const ang = nu + HALLEY.rot;
    return { x: Math.cos(ang) * wd, y: -Math.sin(ang) * wd, rAu };
  }
  const HALLEY_PATH = [];
  for (let i = 0; i <= 160; i++) {
    const E = (i / 160) * TAU;
    const rAu = HALLEY.a * (1 - HALLEY.e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + HALLEY.e) * Math.sin(E / 2), Math.sqrt(1 - HALLEY.e) * Math.cos(E / 2));
    const wd = Math.sqrt(rAu) / MAX_SQRT;
    HALLEY_PATH.push([Math.cos(nu + HALLEY.rot) * wd, -Math.sin(nu + HALLEY.rot) * wd]);
  }

  // asteroid belt (2.1–3.3 AU), kuiper belt (38–48 AU), colored starfield
  const BELT = [];
  for (let i = 0; i < 320; i++) {
    BELT.push({
      a: Math.random() * TAU,
      d: Math.sqrt(2.1 + Math.random() * 1.2) / MAX_SQRT,
      sp: 0.75 + Math.random() * 0.5,
      al: 0.12 + Math.random() * 0.2
    });
  }
  const KUIPER = [];
  for (let i = 0; i < 260; i++) {
    KUIPER.push({
      a: Math.random() * TAU,
      d: Math.sqrt(38 + Math.random() * 10) / MAX_SQRT,
      al: 0.05 + Math.random() * 0.12
    });
  }
  const STAR_COLORS = ['205,214,228', '215,226,205', '228,214,184', '216,168,143'];
  const STARS = [];
  for (let i = 0; i < 700; i++) {
    STARS.push({
      x: (Math.random() * 2 - 1) * 1.8, y: (Math.random() * 2 - 1) * 1.8,
      c: STAR_COLORS[Math.random() < 0.55 ? 0 : Math.floor(Math.random() * STAR_COLORS.length)],
      al: 0.12 + Math.random() * 0.5, tw: Math.random() * TAU,
      sz: Math.random() < 0.08 ? 1.8 : 1, flare: Math.random() < 0.025
    });
  }
  // milky way band: pre-rendered blobs along a diagonal through the field
  const MILKY = [];
  for (let i = 0; i < 90; i++) {
    const t = (i / 90) * 2 - 1;
    MILKY.push({
      x: t * 2.2 + (Math.random() - 0.5) * 0.24,
      y: t * -1.35 + (Math.random() - 0.5) * 0.5,
      r: 0.09 + Math.random() * 0.22,
      al: 0.012 + Math.random() * 0.03
    });
  }

  // camera: world units are orbit-normalized (Pluto = 1.0 from sun)
  const cam = { x: 0, y: 0, z: 1 };
  window.__solarCam = cam; // debug/automation handle
  const Z_MIN = 0.6, Z_MAX = 80;
  let W = 0, H = 0, cx = 0, cy = 0, U = 1, raf;
  // deep-sky background (milky way + static stars) pre-rendered once per resize
  const bg = document.createElement('canvas');
  function renderBg() {
    try {
      bg.width = W; bg.height = H;
      const b = bg.getContext('2d');
      const bu = Math.min(W, H) * 0.46, bcx = W / 2, bcy = H / 2;
      for (const m of MILKY) {
        const mx = bcx + m.x * bu, my = bcy + m.y * bu, mr = m.r * bu * 2.2;
        const g = b.createRadialGradient(mx, my, 0, mx, my, mr);
        g.addColorStop(0, `rgba(210,220,200,${m.al})`);
        g.addColorStop(1, 'rgba(210,220,200,0)');
        b.fillStyle = g;
        b.beginPath(); b.arc(mx, my, mr, 0, Math.PI * 2); b.fill();
      }
      for (const s of STARS) {
        if (s.flare) continue;
        b.fillStyle = `rgba(${s.c},${s.al * 0.85})`;
        b.fillRect(bcx + s.x * bu, bcy + s.y * bu, s.sz * dpr, s.sz * dpr);
      }
    } catch (e) { console.error('renderBg', e); }
  }
  const resize = () => {
    const rect = canvas.parentElement.getBoundingClientRect();
    W = canvas.width = Math.max(1, rect.width * dpr);
    H = canvas.height = Math.max(1, rect.height * dpr);
    renderBg();
  };
  resize();
  addEventListener('resize', resize);
  try { new ResizeObserver(resize).observe(canvas.parentElement); } catch (e) { console.error('resizeObserver', e); }

  /* interaction: wheel zoom to cursor, drag pan, click planet = lane focus,
     dblclick/R reset, +/- buttons; idle >60s = cinematic drift */
  let lastInput = performance.now();
  let camZTarget = null;
  let hits = [];
  const touch = () => { lastInput = performance.now(); };
  function zoomAt(mx, my, factor) {
    touch(); camZTarget = null;
    const wx = cam.x + (mx - cx) / (U * cam.z);
    const wy = cam.y + (my - cy) / (U * cam.z);
    cam.z = clamp(cam.z * factor, Z_MIN, Z_MAX);
    cam.x = clamp(wx - (mx - cx) / (U * cam.z), -1.3, 1.3);
    cam.y = clamp(wy - (my - cy) / (U * cam.z), -1.3, 1.3);
  }
  const resetCam = () => { touch(); camZTarget = null; hideLaneCard(); cam.x = 0; cam.y = 0; cam.z = 1; };
  function planetHit(mx, my) {
    let best = null, bd = Infinity;
    for (const h of hits) {
      const d2 = (h.x - mx) ** 2 + (h.y - my) ** 2;
      const thr = Math.max(16 * dpr, h.r * 2.2);
      if (d2 < thr * thr && d2 < bd) { bd = d2; best = h; }
    }
    return best;
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, Math.exp(-e.deltaY * 0.0014));
  }, { passive: false });
  let drag = null;
  const pincers = new Map(); // pointerId -> {x, y}; two fingers = pinch zoom
  let pinchDist = null;
  canvas.addEventListener('pointerdown', e => {
    touch();
    pincers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { console.error('capture', err); }
    if (pincers.size === 2) {
      drag = null; hideLaneCard(); camZTarget = null;
      const [a, b] = [...pincers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      return;
    }
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, t: performance.now() };
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', e => {
    if (pincers.has(e.pointerId)) pincers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pincers.size === 2 && pinchDist != null) {
      touch();
      const [a, b] = [...pincers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 0 && pinchDist > 0) {
        const rect = canvas.getBoundingClientRect();
        zoomAt(((a.x + b.x) / 2 - rect.left) * dpr, ((a.y + b.y) / 2 - rect.top) * dpr, d / pinchDist);
      }
      pinchDist = d;
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    touch();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; hideLaneCard(); camZTarget = null; }
    if (drag.moved) {
      cam.x = clamp(cam.x - dx * dpr / (U * cam.z), -1.3, 1.3);
      cam.y = clamp(cam.y - dy * dpr / (U * cam.z), -1.3, 1.3);
      drag.x = e.clientX; drag.y = e.clientY;
    }
  });
  const releasePincer = e => {
    pincers.delete(e.pointerId);
    if (pincers.size < 2) pinchDist = null;
  };
  canvas.addEventListener('pointerup', e => {
    releasePincer(e);
    if (drag && e.pointerId === drag.id && !drag.moved && performance.now() - drag.t < 600) {
      const rect = canvas.getBoundingClientRect();
      const hit = planetHit((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
      if (hit) {
        orrery.focus = hit.name;
        camZTarget = Math.max(cam.z, 15);
        showLaneCard(hit.name);
      }
    }
    drag = null; canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('pointercancel', e => {
    releasePincer(e);
    drag = null; canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('dblclick', resetCam);
  canvas.style.cursor = 'grab';
  const ctl = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
  ctl('zoom-in', () => zoomAt(cx, cy, 1.6));
  ctl('zoom-out', () => zoomAt(cx, cy, 1 / 1.6));
  ctl('zoom-reset', resetCam);

  const GA0 = Math.PI * 0.75, GSWEEP = Math.PI * 1.5;
  const biasT = v => (clamp(v, -1, 1) + 1) / 2;
  const DEG = Math.PI / 180;
  const startMs = performance.now();
  const MONO = s => `${s * dpr}px 'JetBrains Mono', monospace`;

  function frame(t) {
    try {
      ctx.clearRect(0, 0, W, H);
      cx = W / 2; cy = H / 2;
      U = Math.min(W, H) * 0.46;
      const simElapsed = reduced ? 0 : (t - startMs) / 1000 * SPEED;
      const daysJ2000 = (Date.now() - J2000) / 86400000 + simElapsed;
      // camera: lane follow -> zoom ease -> idle cinematic drift
      if (orrery.focus) {
        const fp = PLANETS.find(p => p.name === orrery.focus);
        if (fp) {
          const fa = (fp.L0 + 360 * daysJ2000 / fp.period) * DEG;
          cam.x += (Math.cos(fa) * fp.dist - cam.x) * 0.08;
          cam.y += (-Math.sin(fa) * fp.dist - cam.y) * 0.08;
        }
      }
      if (camZTarget != null) {
        cam.z += (camZTarget - cam.z) * 0.07;
        if (Math.abs(camZTarget - cam.z) < 0.05) camZTarget = null;
      }
      const idle = !reduced && !orrery.focus && camZTarget == null && (t - lastInput > 60000);
      if (idle) {
        const it = (t - lastInput - 60000) / 1000;
        cam.x += (0.22 * Math.sin(it * 0.026) - cam.x) * 0.008;
        cam.y += (0.16 * Math.cos(it * 0.021) - cam.y) * 0.008;
        cam.z += ((1.7 + 0.8 * Math.sin(it * 0.015)) - cam.z) * 0.008;
      }
      const z = cam.z;
      // page scroll stays available on touch until you actually zoom in (idle drift never locks it)
      canvas.style.touchAction = (z > 1.1 && !idle) ? 'none' : 'pan-y';
      // defcon color lerp (sun + UI tint)
      for (let i = 0; i < 3; i++) coreState.rgb[i] += (coreState.target[i] - coreState.rgb[i]) * 0.04;
      const [cr, cg, cb] = coreState.rgb.map(Math.round);
      const col = al => `rgba(${cr},${cg},${cb},${al})`;
      const SX = wx => cx + (wx - cam.x) * U * z;
      const SY = wy => cy + (wy - cam.y) * U * z;
      const pScale = Math.pow(z, 0.9);
      const onScreen = (x, y, m) => x > -m && x < W + m && y > -m && y < H + m;

      // deep sky: pre-rendered milky way + stars, then live twinkle layer
      ctx.drawImage(bg, 0, 0);
      for (const s of STARS) {
        if (!s.flare) continue;
        const tw = reduced ? 1 : 0.6 + 0.4 * Math.sin(t * 0.0009 + s.tw);
        const sx = cx + s.x * U, sy = cy + s.y * U;
        ctx.fillStyle = `rgba(${s.c},${s.al * tw})`;
        ctx.fillRect(sx - dpr, sy - dpr, 2.4 * dpr, 2.4 * dpr);
        ctx.fillStyle = `rgba(${s.c},${s.al * tw * 0.4})`;
        ctx.fillRect(sx - 4 * dpr, sy, 8 * dpr, dpr);
        ctx.fillRect(sx, sy - 4 * dpr, dpr, 8 * dpr);
      }

      // orbit paths
      ctx.lineWidth = dpr * 0.6;
      for (const p of PLANETS) {
        const orbR = p.dist * U * z;
        if (orbR < 8 * dpr || orbR > Math.max(W, H) * 2.5) continue;
        ctx.strokeStyle = col(p.dwarf ? 0.06 : 0.10);
        ctx.beginPath(); ctx.arc(SX(0), SY(0), orbR, 0, TAU); ctx.stroke();
      }
      // halley's orbit path
      ctx.strokeStyle = col(0.07);
      ctx.beginPath();
      for (let i = 0; i < HALLEY_PATH.length; i++) {
        const [hx, hy] = HALLEY_PATH[i];
        i === 0 ? ctx.moveTo(SX(hx), SY(hy)) : ctx.lineTo(SX(hx), SY(hy));
      }
      ctx.stroke();

      // asteroid + kuiper belts
      for (const b of BELT) {
        const ang = b.a + simElapsed / 1682 * TAU * b.sp;
        const bx = SX(Math.cos(ang) * b.d), by = SY(-Math.sin(ang) * b.d);
        if (!onScreen(bx, by, 10)) continue;
        ctx.fillStyle = `rgba(180,175,150,${b.al})`;
        ctx.fillRect(bx, by, dpr, dpr);
      }
      for (const k of KUIPER) {
        const kx = SX(Math.cos(k.a) * k.d), ky = SY(-Math.sin(k.a) * k.d);
        if (!onScreen(kx, ky, 10)) continue;
        ctx.fillStyle = `rgba(160,170,190,${k.al})`;
        ctx.fillRect(kx, ky, dpr, dpr);
      }

      // sun: corona spikes + tinted glow + white core
      const sunX = SX(0), sunY = SY(0);
      const sunR = 9 * dpr * pScale;
      if (onScreen(sunX, sunY, sunR * 4 + 80 * dpr)) {
        ctx.lineWidth = dpr;
        for (let i = 0; i < 12; i++) {
          const ca2 = (i / 12) * TAU + (reduced ? 0 : t * 0.00004);
          const flick = reduced ? 1 : 0.75 + 0.25 * Math.sin(t * 0.0011 + i * 2.1);
          const r1 = sunR * 1.15, r2 = sunR * (1.6 + 0.35 * flick);
          ctx.strokeStyle = col(0.10 * flick);
          ctx.beginPath();
          ctx.moveTo(sunX + Math.cos(ca2) * r1, sunY + Math.sin(ca2) * r1);
          ctx.lineTo(sunX + Math.cos(ca2) * r2, sunY + Math.sin(ca2) * r2);
          ctx.stroke();
        }
        const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 3.2);
        glow.addColorStop(0, '#fff6dc');
        glow.addColorStop(0.22, col(0.85));
        glow.addColorStop(0.45, col(0.22));
        glow.addColorStop(1, col(0));
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(sunX, sunY, sunR * 3.2, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff3d6';
        ctx.beginPath(); ctx.arc(sunX, sunY, sunR, 0, TAU); ctx.fill();
      }

      // bias gauge orbits the sun, inside Mercury
      const gaugeR = 0.062 * U * z;
      if (coreState.bias != null && gaugeR > 26 * dpr) {
        ctx.lineWidth = dpr;
        ctx.strokeStyle = col(0.14);
        ctx.beginPath(); ctx.arc(sunX, sunY, gaugeR, GA0, GA0 + GSWEEP); ctx.stroke();
        for (const th of [coreState.skipTh, coreState.upTh]) {
          const ang = GA0 + GSWEEP * biasT(th);
          ctx.strokeStyle = col(0.4);
          ctx.beginPath();
          ctx.moveTo(sunX + Math.cos(ang) * (gaugeR - 4 * dpr), sunY + Math.sin(ang) * (gaugeR - 4 * dpr));
          ctx.lineTo(sunX + Math.cos(ang) * (gaugeR + 4 * dpr), sunY + Math.sin(ang) * (gaugeR + 4 * dpr));
          ctx.stroke();
        }
        const vAng = GA0 + GSWEEP * biasT(coreState.bias);
        ctx.strokeStyle = col(0.6);
        ctx.lineWidth = dpr * 2;
        ctx.beginPath(); ctx.arc(sunX, sunY, gaugeR, GA0, vAng); ctx.stroke();
        ctx.fillStyle = col(0.95);
        ctx.beginPath(); ctx.arc(sunX + Math.cos(vAng) * gaugeR, sunY + Math.sin(vAng) * gaugeR, dpr * 2.4, 0, TAU); ctx.fill();
      }

      // halley's comet: head + anti-sunward tail
      const hw = halleyWorld(simElapsed);
      const hpx = SX(hw.x), hpy = SY(hw.y);
      if (onScreen(hpx, hpy, 120 * dpr)) {
        const hd = Math.hypot(hw.x, hw.y) || 1e-6;
        const tailWorld = clamp(0.015 + 0.05 * (3 / Math.max(hw.rAu, 0.5)), 0.015, 0.13);
        const tx = hpx + (hw.x / hd) * tailWorld * U * z;
        const ty = hpy + (hw.y / hd) * tailWorld * U * z;
        const tg = ctx.createLinearGradient(hpx, hpy, tx, ty);
        tg.addColorStop(0, 'rgba(205,220,235,0.5)');
        tg.addColorStop(1, 'rgba(205,220,235,0)');
        ctx.strokeStyle = tg;
        ctx.lineWidth = Math.max(dpr, 2.2 * dpr * Math.pow(z, 0.35));
        ctx.beginPath(); ctx.moveTo(hpx, hpy); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.fillStyle = '#dce8f2';
        ctx.beginPath(); ctx.arc(hpx, hpy, Math.max(1.4 * dpr, 1.6 * dpr * Math.pow(z, 0.35)), 0, TAU); ctx.fill();
        if (z > 3) {
          ctx.textAlign = 'center';
          ctx.fillStyle = 'rgba(205,220,235,0.75)';
          ctx.font = MONO(8);
          ctx.fillText('1P/HALLEY', hpx, hpy - 9 * dpr);
        }
      }

      // planets at their real current positions (mean longitude since J2000)
      ctx.textAlign = 'center';
      hits = [];
      for (const p of PLANETS) {
        const ang = (p.L0 + 360 * daysJ2000 / p.period) * DEG;
        const wx = Math.cos(ang) * p.dist, wy = -Math.sin(ang) * p.dist;
        const px = SX(wx), py = SY(wy);
        const pr = Math.max(1.1 * dpr, p.r * dpr * pScale);
        if (!onScreen(px, py, pr * 4 + 70 * dpr)) continue;
        const sunAng = Math.atan2(wy, wx);
        hits.push({ name: p.name, x: px, y: py, r: pr });

        // atmosphere halo
        if (p.halo && pr > 2.5 * dpr) {
          const hg = ctx.createRadialGradient(px, py, pr * 0.8, px, py, pr * 1.6);
          hg.addColorStop(0, p.halo);
          hg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = hg;
          ctx.beginPath(); ctx.arc(px, py, pr * 1.6, 0, TAU); ctx.fill();
        }
        // saturn ring system, back half first (3 rings, cassini-style gaps)
        const ringSet = [[1.45, 0.16, 0.5], [1.78, 0.22, 0.6], [2.18, 0.13, 0.35]];
        const drawRings = (a0, a1, mul) => {
          ctx.save();
          ctx.translate(px, py); ctx.rotate(-0.4);
          for (const [rr, wdt, al] of ringSet) {
            ctx.strokeStyle = `rgba(184,168,126,${al * mul})`;
            ctx.lineWidth = Math.max(dpr * 0.6, pr * wdt);
            ctx.beginPath(); ctx.ellipse(0, 0, pr * rr, pr * rr * 0.34, 0, a0, a1); ctx.stroke();
          }
          ctx.restore();
        };
        if (p.rings && pr > 2.4 * dpr) drawRings(Math.PI, TAU, 0.8);

        // body: lit sphere, highlight offset toward the sun (limb darkening)
        if (pr > 2.5 * dpr) {
          const lx = px - Math.cos(sunAng) * pr * 0.45, ly = py - Math.sin(sunAng) * pr * 0.45;
          const bodyG = ctx.createRadialGradient(lx, ly, pr * 0.15, px, py, pr * 1.05);
          bodyG.addColorStop(0, p.light);
          bodyG.addColorStop(0.55, p.color);
          bodyG.addColorStop(1, p.dark);
          ctx.fillStyle = bodyG;
        } else {
          ctx.fillStyle = p.color;
        }
        ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();

        // surface detail, clipped to the disk
        if (pr > 5 * dpr) {
          ctx.save();
          ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.clip();
          const drift = reduced ? 0 : t * 0.00003;
          if (p.earth) {
            ctx.fillStyle = 'rgba(111,174,125,0.85)';
            for (const [ox, oy, rx, ry, rot] of [[-0.3, -0.25, 0.42, 0.3, 0.4], [0.35, 0.15, 0.3, 0.38, -0.3], [-0.1, 0.55, 0.34, 0.18, 0.1]]) {
              ctx.beginPath();
              ctx.ellipse(px + Math.cos(drift + ox * 3) * pr * 0.4 + ox * pr * 0.3, py + oy * pr, pr * rx, pr * ry, rot, 0, TAU);
              ctx.fill();
            }
            ctx.strokeStyle = 'rgba(255,255,255,0.22)';
            ctx.lineWidth = pr * 0.09;
            for (const oy of [-0.45, 0.2]) {
              ctx.beginPath();
              ctx.moveTo(px - pr, py + pr * oy);
              ctx.quadraticCurveTo(px, py + pr * (oy + 0.18), px + pr, py + pr * (oy - 0.05));
              ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255,255,255,0.75)';
            ctx.beginPath(); ctx.ellipse(px, py - pr * 0.88, pr * 0.5, pr * 0.16, 0, 0, TAU); ctx.fill();
          }
          if (p.mars) {
            ctx.fillStyle = 'rgba(255,250,245,0.8)';
            ctx.beginPath(); ctx.ellipse(px, py - pr * 0.8, pr * 0.38, pr * 0.16, 0, 0, TAU); ctx.fill();
            ctx.fillStyle = 'rgba(80,45,30,0.3)';
            ctx.beginPath(); ctx.ellipse(px + pr * 0.15, py + pr * 0.15, pr * 0.5, pr * 0.22, 0.5, 0, TAU); ctx.fill();
          }
          if (p.bands) {
            for (let bi = 0; bi < 5; bi++) {
              const off = -0.62 + bi * 0.3;
              ctx.strokeStyle = bi % 2 ? 'rgba(120,90,60,0.28)' : 'rgba(90,64,44,0.35)';
              ctx.lineWidth = Math.max(dpr, pr * (0.1 + (bi % 2) * 0.05));
              ctx.beginPath();
              ctx.moveTo(px - pr, py + pr * off);
              ctx.quadraticCurveTo(px, py + pr * (off + 0.08), px + pr, py + pr * off);
              ctx.stroke();
            }
            if (p.spot) {
              ctx.fillStyle = 'rgba(184,92,72,0.85)';
              ctx.beginPath();
              ctx.ellipse(px + pr * 0.32 * Math.cos(drift * 8), py + pr * 0.34, pr * 0.24, pr * 0.13, 0.2, 0, TAU);
              ctx.fill();
            }
          }
          if (p.swirls) {
            ctx.strokeStyle = 'rgba(255,255,255,0.16)';
            ctx.lineWidth = pr * 0.1;
            for (const oy of [-0.3, 0.15, 0.55]) {
              ctx.beginPath();
              ctx.moveTo(px - pr, py + pr * (oy - 0.15));
              ctx.quadraticCurveTo(px, py + pr * (oy + 0.2), px + pr, py + pr * (oy - 0.2));
              ctx.stroke();
            }
          }
          if (p.craters) {
            ctx.fillStyle = 'rgba(0,0,0,0.25)';
            for (const [ox, oy, s2] of [[-0.35, -0.2, 0.14], [0.25, 0.3, 0.1], [0.05, -0.45, 0.08], [-0.15, 0.5, 0.09]]) {
              ctx.beginPath(); ctx.arc(px + pr * ox, py + pr * oy, pr * s2, 0, TAU); ctx.fill();
            }
          }
          ctx.restore();
        }
        // day/night terminator: dark on the side facing away from the sun
        if (pr > 3 * dpr) {
          ctx.save();
          ctx.translate(px, py); ctx.rotate(sunAng);
          ctx.fillStyle = 'rgba(6,9,6,0.34)';
          ctx.beginPath(); ctx.arc(0, 0, pr, -Math.PI / 2, Math.PI / 2); ctx.fill();
          ctx.restore();
        }
        if (p.rings && pr > 2.4 * dpr) drawRings(0, Math.PI, 1);
        // uranus: near-vertical ring
        if (p.vring && pr > 4 * dpr) {
          ctx.save();
          ctx.translate(px, py); ctx.rotate(1.35);
          ctx.strokeStyle = 'rgba(159,212,212,0.3)';
          ctx.lineWidth = dpr;
          ctx.beginPath(); ctx.ellipse(0, 0, pr * 1.8, pr * 0.4, 0, 0, TAU); ctx.stroke();
          ctx.restore();
        }

        // moons: real periods, retrograde supported (negative period)
        if (p.moons && z > 5) {
          for (const m of p.moons) {
            const md = m.dist * dpr * pScale * 0.55 + pr;
            const mAng = (daysJ2000 / m.period) * TAU;
            const mx = px + Math.cos(mAng) * md, my = py - Math.sin(mAng) * md;
            ctx.strokeStyle = col(0.08);
            ctx.lineWidth = dpr * 0.5;
            ctx.beginPath(); ctx.arc(px, py, md, 0, TAU); ctx.stroke();
            const mr = Math.max(dpr, m.r * dpr * pScale * 0.5);
            ctx.fillStyle = m.color;
            ctx.beginPath(); ctx.arc(mx, my, mr, 0, TAU); ctx.fill();
            if (z > 14) {
              ctx.fillStyle = 'rgba(121,133,111,0.85)';
              ctx.font = MONO(8);
              ctx.fillText(m.name, mx, my - mr - 4 * dpr);
            }
          }
        }
        // lane health ring (empire orrery)
        const lh = orrery.health[p.name];
        if (lh) {
          const LC = { ok: '178,219,143', warn: '219,179,95', crit: '217,122,108' }[lh];
          const pulse = reduced ? 0.4 : 0.32 + 0.18 * Math.sin(t * 0.0025 + p.dist * 20);
          ctx.strokeStyle = `rgba(${LC},${pulse})`;
          ctx.lineWidth = dpr * 1.2;
          ctx.beginPath(); ctx.arc(px, py, pr * (p.rings ? 2.6 : 1.9), 0, TAU); ctx.stroke();
        }
        // labels
        if (z > 2.2) {
          ctx.fillStyle = p.dwarf ? 'rgba(215,226,205,0.55)' : 'rgba(215,226,205,0.8)';
          ctx.font = MONO(9);
          ctx.fillText(p.name, px, py - pr - 8 * dpr);
          if (z > 7) {
            ctx.fillStyle = 'rgba(121,133,111,0.8)';
            ctx.font = MONO(8);
            ctx.fillText(p.info, px, py - pr - 8 * dpr + 11 * dpr);
          }
        }
      }
      if (z > 2.2) {
        ctx.fillStyle = 'rgba(215,226,205,0.7)';
        ctx.font = MONO(9);
        ctx.fillText('SOL', sunX, sunY - sunR * 1.9 - 8 * dpr);
      }
      // zoom readout
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(74,84,67,0.9)';
      ctx.font = MONO(8.5);
      ctx.fillText(`ZOOM ${z.toFixed(1)}X`, 14 * dpr, H - 34 * dpr);

      raf = requestAnimationFrame(frame);
    } catch (e) {
      console.error('solar frame', e);
      cancelAnimationFrame(raf);
    }
  }
  raf = requestAnimationFrame(frame);
}
initSolarSystem();

/* ---------- boot + poll loops ---------- */
bootFx();
renderSessionBar();
loadDirective(); setInterval(loadDirective, DIRECTIVE_MS);
loadFleet(); setInterval(loadFleet, FLEET_MS);
loadSystem(); setInterval(loadSystem, SYS_MS);
loadTasks(); setInterval(loadTasks, TASKS_MS);
loadIntel(); setInterval(loadIntel, INTEL_MS);
loadNq(); setInterval(loadNq, NQ_MS);
setTimeout(loadSpark, 4000); setInterval(loadSpark, 60000);
