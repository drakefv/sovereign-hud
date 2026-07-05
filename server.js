const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const nqVerdict = require('./verdict');
const { fileAgeMin, readJson: readJsonSafe, etToday } = require('./util');

const PORT = 5300;
const OBSIDIAN_DIR = 'C:/Users/Drake/Obsidian/08 - Claude Memory';
const MEME_DATA = 'C:/Users/Drake/meme-radar/data';
const NQ_DIR = 'C:/Users/Drake/nq-bot';
const NQ_CACHE_MS = 15000;
const TASK_CACHE_MS = 30000;
const FLEET_CACHE_MS = 3000;
const WALLETS_CACHE_MS = 30000;
const DEFAULT_TASK_FILTER = 'NQ|Fade|TL-|bot|Tape|watchdog|daemon|life-os';

function readDirective() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'directive.json'), 'utf8'));
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '32kb' }));

const log = (...args) => console.log(new Date().toISOString(), ...args);

function run(cmd, timeout = 15000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// shared pm2 snapshot: one shell-out serves /api/fleet, tape samplers, and any
// future consumer — pm2 jlist forks a node proc + serializes every env, so dedupe hard
let pm2Snap = { at: 0, data: null, promise: null };
function getPm2(maxAgeMs) {
  if (Date.now() - pm2Snap.at < maxAgeMs && pm2Snap.data) return Promise.resolve(pm2Snap.data);
  if (!pm2Snap.promise) {
    pm2Snap.promise = run('pm2 jlist').then(out => {
      pm2Snap = { at: Date.now(), data: JSON.parse(out.slice(out.indexOf('['))), promise: null };
      return pm2Snap.data;
    }).catch(err => { pm2Snap.promise = null; throw err; });
  }
  return pm2Snap.promise;
}

let fleetCache = { at: 0, data: null };
app.get('/api/fleet', async (_req, res) => {
  try {
    if (Date.now() - fleetCache.at < FLEET_CACHE_MS && fleetCache.data) {
      return res.json(fleetCache.data);
    }
    const list = await getPm2(FLEET_CACHE_MS);
    fleetCache = { at: Date.now(), data: list.map(p => ({
      name: p.name,
      status: p.pm2_env.status,
      cpu: p.monit ? p.monit.cpu : 0,
      memMb: p.monit ? Math.round(p.monit.memory / 1048576) : 0,
      restarts: p.pm2_env.restart_time,
      uptimeMs: p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0
    })) };
    res.json(fleetCache.data);
  } catch (e) {
    log('fleet error:', e.message);
    if (fleetCache.data) return res.json(fleetCache.data);
    res.status(503).json({ error: 'pm2 unreachable' });
  }
});

// shared schtasks snapshot: unfiltered [{name, state}], same dedupe pattern as
// getPm2 — /api/tasks applies the directive filter, warroom matches exact names
let taskSnap = { at: 0, data: null, promise: null };
function getTasks(maxAgeMs) {
  if (Date.now() - taskSnap.at < maxAgeMs && taskSnap.data) return Promise.resolve(taskSnap.data);
  if (!taskSnap.promise) {
    const stateNames = { 0: 'unknown', 1: 'disabled', 2: 'queued', 3: 'ready', 4: 'running' };
    taskSnap.promise = run(
      'powershell -NoProfile -Command "Get-ScheduledTask | Select-Object TaskName,State | ConvertTo-Json -Compress"',
      25000
    ).then(out => {
      const parsed = JSON.parse(out);
      const all = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      taskSnap = {
        at: Date.now(),
        data: all.map(t => ({ name: t.TaskName, state: stateNames[t.State] || String(t.State) })),
        promise: null
      };
      return taskSnap.data;
    }).catch(err => { taskSnap.promise = null; throw err; });
  }
  return taskSnap.promise;
}

app.get('/api/tasks', async (_req, res) => {
  const respond = all => {
    let filter;
    try { filter = new RegExp(readDirective().taskFilter || DEFAULT_TASK_FILTER, 'i'); }
    catch (e) { log('taskFilter invalid, using default:', e.message); filter = new RegExp(DEFAULT_TASK_FILTER, 'i'); }
    res.json(all
      .filter(t => filter.test(t.name))
      .sort((a, b) =>
        (Number(b.state === 'running') - Number(a.state === 'running')) ||
        a.name.localeCompare(b.name)));
  };
  try {
    respond(await getTasks(TASK_CACHE_MS));
  } catch (e) {
    log('tasks error:', e.message);
    if (taskSnap.data) return respond(taskSnap.data);
    res.status(503).json({ error: 'schtasks unreachable' });
  }
});

app.get('/api/system', (_req, res) => {
  try {
    const cpus = os.cpus();
    res.json({
      hostname: os.hostname(),
      uptimeSec: os.uptime(),
      memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      memTotalGb: +(os.totalmem() / 1073741824).toFixed(1),
      cores: cpus.length,
      loadHint: cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim() : ''
    });
  } catch (e) {
    log('system error:', e.message);
    res.status(500).json({ error: 'system read failed' });
  }
});

async function readLines(file, count) {
  const raw = await fs.promises.readFile(path.join(OBSIDIAN_DIR, file), 'utf8');
  return raw.split('\n').slice(0, count).join('\n');
}

app.get('/api/intel', async (_req, res) => {
  try {
    const [activeContext, sessionLog] = await Promise.all([
      readLines('Active Context.md', 40),
      readLines('Session Log.md', 30)
    ]);
    res.json({ activeContext, sessionLog });
  } catch (e) {
    log('intel error:', e.message);
    res.status(503).json({ error: 'obsidian unreachable' });
  }
});

// Copytrade forward test: miner candidates x live follows x recorded outcomes.
// Reads meme-radar's data files directly (read-only, same box).
function readJsonl(p) {
  const rows = [];
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { rows.push(JSON.parse(t)); } catch { /* torn line */ }
    }
  } catch { /* missing file */ }
  return rows;
}
function readJsonlDays(prefix, days) {
  const rows = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    rows.push(...readJsonl(path.join(MEME_DATA, `${prefix}-${day}.jsonl`)));
  }
  return rows;
}

let walletsCache = { at: 0, data: null };
app.get('/api/wallets', (_req, res) => {
  try {
    if (Date.now() - walletsCache.at < WALLETS_CACHE_MS && walletsCache.data) {
      return res.json(walletsCache.data);
    }
    const smart = JSON.parse(fs.readFileSync(path.join(MEME_DATA, 'smart-wallets.json'), 'utf8'));
    const follows = readJsonlDays('follows', 3);
    const outs = readJsonlDays('followouts', 3);

    // entry price (+1m checkpoint) and +1h outcome per wallet|mint
    const entry = new Map(), h1 = new Map();
    for (const o of outs) {
      const k = `${o.wallet}|${o.mint}`;
      if (o.checkpoint === '1m' && o.priceUsd > 0) entry.set(k, o.priceUsd);
      if (o.checkpoint === '1h') h1.set(k, o);
    }
    const mintsByWallet = new Map();
    for (const f of follows) {
      if (!mintsByWallet.has(f.wallet)) mintsByWallet.set(f.wallet, new Set());
      mintsByWallet.get(f.wallet).add(f.mint);
    }
    const candidates = (smart.candidates || []).map(c => {
      const mints = [...(mintsByWallet.get(c.wallet) || [])];
      let fwdChecked = 0, fwdPos = 0;
      for (const m of mints) {
        const k = `${c.wallet}|${m}`;
        const out = h1.get(k);
        if (!out) continue;
        const e = entry.get(k);
        if (out.listing === 'found' && e && out.priceUsd > 0) {
          fwdChecked++;
          if (out.priceUsd > e) fwdPos++;
        } else if (out.listing === 'notFound') {
          fwdChecked++; // delisted within the hour = a loss for the copier
        }
      }
      return { wallet: c.wallet, wins: c.wins, losses: c.losses, follows: mints.length, fwdChecked, fwdPos };
    }).sort((a, b) => b.follows - a.follows || b.wins - a.wins);
    const recent = follows
      .sort((a, b) => Date.parse(b.t) - Date.parse(a.t))
      .slice(0, 8)
      .map(f => ({ t: f.t, wallet: f.wallet, mint: f.mint }));
    const totals = candidates.reduce(
      (s, c) => ({ follows: s.follows + c.follows, fwdChecked: s.fwdChecked + c.fwdChecked, fwdPos: s.fwdPos + c.fwdPos }),
      { follows: 0, fwdChecked: 0, fwdPos: 0 });
    walletsCache = { at: Date.now(), data: { minedAt: smart.generatedAt, candidates, recent, totals } };
    res.json(walletsCache.data);
  } catch (e) {
    log('wallets error:', e.message);
    if (walletsCache.data) return res.json(walletsCache.data);
    res.status(503).json({ error: 'wallet data unavailable' });
  }
});

// NQ desk: bot state straight off nq-bot's own JSON artifacts (read-only, same box).
function lastJsonlLine(p) {
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      try { return JSON.parse(t); } catch { /* torn tail line */ }
    }
  } catch { /* missing file */ }
  return null;
}

let nqCache = { at: 0, data: null };
app.get('/api/nq', (_req, res) => {
  try {
    if (Date.now() - nqCache.at < NQ_CACHE_MS && nqCache.data) {
      return res.json(nqCache.data);
    }
    const pnl = lastJsonlLine(path.join(NQ_DIR, 'data/multi_firm_pnl.jsonl'));
    const acct = pnl ? (Object.values(pnl.firms || {}).flat()[0] || null) : null;
    const bias = readJsonSafe(path.join(NQ_DIR, 'data/phase_s_daily.json'));
    const flags = readJsonSafe(path.join(NQ_DIR, 'data/strategy_pause_flags.json'));
    const circuit = readJsonSafe(path.join(NQ_DIR, 'data/circuit_state.json'));
    const today = etToday();
    nqCache = { at: Date.now(), data: {
      account: acct && {
        balance: acct.current_balance_usd,
        realized: acct.realized_pnl_usd,
        lockState: acct.lock_state,
        lockReason: acct.lock_reason,
        openSize: acct.open_position_size,
        openSide: acct.open_position_side,
        sessionDate: acct.session_date_et,
        stateAgeMin: Math.round(acct.state_age_minutes || 0)
      },
      pnlTs: pnl ? pnl.ts : null,
      bias: bias && {
        composite: bias.composite,
        skipReason: bias.skip_reason,
        upsizeReason: bias.upsize_reason,
        components: bias.components,
        skipThreshold: bias.skip_threshold,
        upsizeThreshold: bias.upsize_threshold,
        asof: bias.asof_date
      },
      guards: {
        portfolioKill: !!(flags && flags.portfolio_kill),
        killReason: flags ? flags.kill_reason : null,
        circuitTripped: !!(circuit && circuit.tripped),
        tripReason: circuit ? circuit.trip_reason : null,
        cooloffUntil: circuit ? circuit.cooloff_until_iso : null,
        paused: flags ? Object.entries(flags.strategies || {}).filter(([, v]) => v.paused).map(([k]) => k) : []
      },
      pulse: {
        stratLogAgeMin: fileAgeMin(path.join(NQ_DIR, `logs/run_strategy_${today}.log`)),
        schedulerAgeMin: fileAgeMin(path.join(NQ_DIR, 'data/scheduler_state.json'))
      },
      econ: (() => {
        const cal = readJsonSafe(path.join(NQ_DIR, 'data/econ_calendar.json'));
        if (!cal || !Array.isArray(cal.events)) return { events: [], lastPast: null };
        const now = Date.now();
        const parsed = cal.events
          // naive timestamps are ET-local; assume EDT (-04:00) — worst case 1h off in winter, fine for countdown chips
          .map(e => ({ name: e.name, category: e.category, impact: e.impact,
            ts: Date.parse(/[+-]\d\d:\d\d$|Z$/.test(e.start_et) ? e.start_et : e.start_et + '-04:00') }))
          .filter(e => Number.isFinite(e.ts))
          .sort((a, b) => a.ts - b.ts);
        return {
          events: parsed.filter(e => e.ts > now).slice(0, 3),
          lastPast: parsed.filter(e => e.ts <= now).map(e => e.ts).pop() || null
        };
      })(),
      // Express fleet: each account's independent kill-switch seatbelt state
      fleet: (readDirective().nqFleet || []).map(f => {
        const dir = path.join(NQ_DIR, f.dir);
        const ks = readJsonSafe(path.join(dir, 'kill_switch_state.json'));
        return {
          label: f.label,
          account: f.account,
          balance: ks ? ks.last_balance_usd : null,
          hwm: ks ? ks.high_water_mark_usd : null,
          blind: ks ? (ks.consecutive_blind_cycles || 0) : null,
          guardAgeMin: ks && ks.updated_iso ? Math.round((Date.now() - Date.parse(ks.updated_iso)) / 60000) : null,
          fired: fs.existsSync(path.join(dir, 'kill_switch_fired.json')),
          disabled: fs.existsSync(path.join(dir, 'kill_switch_disabled.flag'))
        };
      }),
      etDate: today
    } };
    // single source of truth for SKIP/CLEAR/UPSIZE/LOCKED — frontend and tape consume this
    nqCache.data.verdict = nqVerdict(nqCache.data);
    res.json(nqCache.data);
  } catch (e) {
    log('nq error:', e.message);
    if (nqCache.data) return res.json(nqCache.data);
    res.status(503).json({ error: 'nq state unavailable' });
  }
});

// spark history: ring buffers persisted to disk so trends survive restarts
const SPARK_FILE = path.join(__dirname, 'data', 'spark.json');
const spark = { mem: [], restarts: [], green: [], flow: [] };
try {
  const saved = JSON.parse(fs.readFileSync(SPARK_FILE, 'utf8'));
  for (const k of Object.keys(spark)) if (Array.isArray(saved[k])) spark[k] = saved[k];
} catch { /* first boot */ }
setInterval(() => {
  try {
    fs.mkdirSync(path.dirname(SPARK_FILE), { recursive: true });
    fs.writeFileSync(SPARK_FILE, JSON.stringify(spark));
  } catch (e) { log('spark save error:', e.message); }
}, 120000);
const pushSpark = (arr, v, max) => { arr.push(v); if (arr.length > max) arr.shift(); };
setInterval(() => {
  try {
    pushSpark(spark.mem, Math.round((1 - os.freemem() / os.totalmem()) * 100), 120);
    if (fleetCache.data) {
      pushSpark(spark.restarts, fleetCache.data.reduce((s, p) => s + (p.restarts || 0), 0), 120);
    }
  } catch (e) { log('spark sample error:', e.message); }
}, 30000);
setInterval(() => {
  try {
    if (walletsCache.data && walletsCache.data.totals && walletsCache.data.totals.fwdChecked > 0) {
      const t = walletsCache.data.totals;
      pushSpark(spark.green, Math.round(100 * t.fwdPos / t.fwdChecked), 96);
    }
  } catch (e) { log('spark green error:', e.message); }
}, 300000);
app.get('/api/spark', (_req, res) => {
  try { res.json(spark); } catch (e) { res.status(500).json({ error: 'spark failed' }); }
});

app.get('/api/directive', (_req, res) => {
  try {
    res.json(readDirective());
  } catch (e) {
    log('directive error:', e.message);
    res.status(500).json({ error: 'directive.json missing or invalid' });
  }
});

require('./rails')(app, { run, log, readDirective, readJsonSafe, spark });
const pushApi = require('./push')(app, { run, log, readDirective, readJsonSafe, lastJsonlLine, getPm2 }) || { send: null };
const tapeApi = require('./tape')(app, { run, log, readDirective, readJsonSafe, lastJsonlLine, getPm2, readJsonl, nqVerdict });

// 07-05 sentries: reply sniper, PALS watcher, war room, morning digest —
// all fire through the tape (emit) and the push uplink (send)
const sentryCtx = {
  run, log, readDirective, readJsonSafe, lastJsonlLine, getPm2, getTasks, nqVerdict,
  push: pushApi.send, emit: tapeApi.emit, getEvents: tapeApi.getEvents
};
require('./sniper')(app, sentryCtx);
require('./pals')(app, sentryCtx);
require('./warroom')(app, sentryCtx);
require('./digest')(app, sentryCtx);

app.listen(PORT, '0.0.0.0', () => log(`SOVEREIGN HUD live on http://0.0.0.0:${PORT}`));
