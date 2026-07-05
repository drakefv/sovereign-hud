// tape.js — THE TAPE: one merged, timestamped event stream for the whole empire.
// Server-side samplers diff each rail's source-of-truth and emit events into a
// persisted ring buffer. Additive module, same pattern as rails.js / push.js.
'use strict';

const fs = require('fs');
const path = require('path');

const MEME_DATA = 'C:/Users/Drake/meme-radar/data';
const NQ_DIR = 'C:/Users/Drake/nq-bot';
const BOT_ARMY_DATA = 'C:/Users/Drake/bot-army/data';
const VOICE_NOTES = 'C:/Users/Drake/Obsidian/08 - Claude Memory/Voice Notes.md';

const TAPE_FILE = path.join(__dirname, 'data', 'tape.json');
const MAX_EVENTS = 250;
const MAX_SEEN = 3000;
const SAVE_MS = 120000;
const PM2_MS = 20000;
const FLOW_MS = 45000;
const KEYSTONE_MS = 60000;
const NQ_MS = 60000;
const LYDIA_MS = 60000;
const ECON_MS = 60000;

const { fileSig } = require('./util');

const dayStr = () => new Date().toISOString().slice(0, 10);
const shortMint = a => (typeof a === 'string' && a.length > 10) ? a.slice(0, 4) + '…' + a.slice(-4) : String(a || '?');

module.exports = function installTape(app, ctx) {
  const { log, readJsonSafe, lastJsonlLine, getPm2, readJsonl, nqVerdict } = ctx;

  let events = [];
  try {
    const saved = JSON.parse(fs.readFileSync(TAPE_FILE, 'utf8'));
    if (Array.isArray(saved)) events = saved.slice(0, MAX_EVENTS);
  } catch { /* first boot */ }

  // dedupe memory is deliberately larger than the visible buffer, and decoupled
  // from it — otherwise a busy day (>MAX_EVENTS) re-emits still-on-disk events
  // the moment they scroll off the ring
  const seen = new Set(events.map(e => e.key));
  let dirty = false;
  function emit(kind, msg, cls, key) {
    const k = key || `${kind}:${msg}`;
    if (seen.has(k)) return;
    seen.add(k);
    if (seen.size > MAX_SEEN) {
      const it = seen.values();
      for (let i = 0; i < MAX_SEEN / 6; i++) seen.delete(it.next().value);
    }
    events.unshift({ t: Date.now(), kind, msg, cls: cls || 'info', key: k });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    dirty = true;
  }

  setInterval(() => {
    if (!dirty) return;
    try {
      fs.mkdirSync(path.dirname(TAPE_FILE), { recursive: true });
      fs.writeFileSync(TAPE_FILE, JSON.stringify(events));
      dirty = false;
    } catch (e) { log('tape save error:', e.message); }
  }, SAVE_MS);

  /* ---- pm2 transitions: status flips + restart increments (shared snapshot) ---- */
  let prevProcs = null;
  setInterval(async () => {
    try {
      const procs = new Map((await getPm2(PM2_MS - 5000)).map(p =>
        [p.name, { status: p.pm2_env.status, restarts: p.pm2_env.restart_time }]));
      if (prevProcs) {
        for (const [name, cur] of procs) {
          const old = prevProcs.get(name);
          if (!old) { emit('fleet', `${name} JOINED FLEET`, 'ok', `join:${name}:${Date.now()}`); continue; }
          if (old.status !== cur.status) {
            const up = cur.status === 'online';
            emit('fleet', `${name} ${cur.status.toUpperCase()}`,
              up ? 'ok' : cur.status === 'errored' ? 'crit' : 'warn',
              `st:${name}:${cur.status}:${Date.now()}`);
          } else if (cur.restarts > old.restarts) {
            emit('fleet', `${name} RESTARTED · R${cur.restarts}`, 'warn', `rst:${name}:${cur.restarts}`);
          }
        }
        for (const name of prevProcs.keys()) {
          if (!procs.has(name)) emit('fleet', `${name} LEFT FLEET`, 'warn', `left:${name}:${Date.now()}`);
        }
      }
      prevProcs = procs;
    } catch (e) { log('tape pm2 error:', e.message); }
  }, PM2_MS);

  /* ---- meme flow-quality fires ---- */
  let flowSig = null;
  setInterval(() => {
    try {
      const p = path.join(MEME_DATA, `flowq-${dayStr()}.jsonl`);
      const sig = fileSig(p);
      if (sig === flowSig) return;
      flowSig = sig;
      for (const r of readJsonl(p)) {
        if (!r.t || !r.mint) continue;
        emit('flow',
          `FLOW FIRE ${shortMint(r.mint)} · ${r.uniqueBuyers || 0}B · ×${(+r.trigMult || 0).toFixed(2)}${r.saturated ? ' · SAT' : ''}`,
          'flow', `fq:${r.t}:${r.mint}`);
      }
    } catch (e) { log('tape flow error:', e.message); }
  }, FLOW_MS);

  /* ---- keystone: sends + reply-watch movement ---- */
  let prevUid = null, draftsSig = null;
  setInterval(() => {
    try {
      const draftsFile = path.join(BOT_ARMY_DATA, 'email-drafts.json');
      const sig = fileSig(draftsFile);
      if (sig !== draftsSig) {
        draftsSig = sig;
        for (const d of (readJsonSafe(draftsFile) || {}).drafts || []) {
          if (d.status !== 'sent') continue;
          emit('keystone', `KEYSTONE SENT — ${d.businessName || d.email || '?'}`, 'ok',
            `ks:${d.email || d.businessName}:sent`);
        }
      }
      const rs = readJsonSafe(path.join(BOT_ARMY_DATA, 'email-reply-state.json'));
      if (rs && rs.lastUid != null) {
        if (prevUid != null && rs.lastUid !== prevUid) {
          emit('keystone', `INBOX MOVEMENT — REPLY WATCH UID ${rs.lastUid}`, 'hot', `ksuid:${rs.lastUid}`);
        }
        prevUid = rs.lastUid;
      }
    } catch (e) { log('tape keystone error:', e.message); }
  }, KEYSTONE_MS);

  /* ---- NQ: verdict + guard transitions off the same files the desk reads ---- */
  let prevVerdict = null, prevKill = null, prevCircuit = null, prevLock = null;
  setInterval(() => {
    try {
      const bias = readJsonSafe(path.join(NQ_DIR, 'data/phase_s_daily.json'));
      const flags = readJsonSafe(path.join(NQ_DIR, 'data/strategy_pause_flags.json'));
      const circuit = readJsonSafe(path.join(NQ_DIR, 'data/circuit_state.json'));
      const pnl = lastJsonlLine(path.join(NQ_DIR, 'data/multi_firm_pnl.jsonl'));
      const acct = pnl ? (Object.values(pnl.firms || {}).flat()[0] || null) : null;

      const kill = !!(flags && flags.portfolio_kill);
      const trip = !!(circuit && circuit.tripped);
      const lock = (acct && acct.lock_state) || null;
      // shared evaluator (verdict.js) — bias-only view so LOCKED transitions
      // stay their own dedicated events below
      const verdict = nqVerdict.fromBiasFile(bias).text;
      if (prevVerdict != null && verdict !== prevVerdict) {
        emit('nq', `NQ VERDICT ${prevVerdict} → ${verdict}${bias && bias.composite != null ? ` · BIAS ${bias.composite > 0 ? '+' : ''}${bias.composite}` : ''}`,
          verdict === 'SKIP DAY' ? 'warn' : verdict === 'UPSIZE' ? 'hot' : 'ok',
          `nqv:${verdict}:${bias ? bias.asof_date : ''}:${Date.now()}`);
      }
      if (prevKill != null && kill !== prevKill) {
        emit('nq', kill ? `NQ PORTFOLIO KILL — ${flags.kill_reason || 'manual'}` : 'NQ PORTFOLIO KILL LIFTED',
          kill ? 'crit' : 'ok', `nqk:${kill}:${Date.now()}`);
      }
      if (prevCircuit != null && trip !== prevCircuit) {
        emit('nq', trip ? `NQ CIRCUIT TRIPPED — ${circuit.trip_reason || ''}` : 'NQ CIRCUIT RESET',
          trip ? 'crit' : 'ok', `nqc:${trip}:${Date.now()}`);
      }
      if (prevLock != null && lock !== prevLock && lock) {
        emit('nq', `NQ ACCOUNT ${String(lock).toUpperCase()}${acct.lock_reason ? ' — ' + acct.lock_reason : ''}`,
          lock === 'open' ? 'ok' : 'crit', `nql:${lock}:${Date.now()}`);
      }
      prevVerdict = verdict; prevKill = kill; prevCircuit = trip; prevLock = lock;
    } catch (e) { log('tape nq error:', e.message); }
  }, NQ_MS);

  /* ---- lydia voice notes ---- */
  let prevNoteMs = null;
  setInterval(() => {
    try {
      const ms = fs.statSync(VOICE_NOTES).mtimeMs;
      if (prevNoteMs != null && ms > prevNoteMs) {
        emit('lydia', 'VOICE NOTE LANDED — LYDIA WROTE TO THE VAULT', 'hot', `vn:${Math.round(ms)}`);
      }
      prevNoteMs = ms;
    } catch { /* vault offline */ }
  }, LYDIA_MS);

  /* ---- econ prints crossing NOW ---- */
  setInterval(() => {
    try {
      const cal = readJsonSafe(path.join(NQ_DIR, 'data/econ_calendar.json'));
      if (!cal || !Array.isArray(cal.events)) return;
      const now = Date.now();
      for (const e of cal.events) {
        const ts = Date.parse(/[+-]\d\d:\d\d$|Z$/.test(e.start_et) ? e.start_et : e.start_et + '-04:00');
        if (!Number.isFinite(ts)) continue;
        if (ts <= now && now - ts < 3 * 60000) {
          emit('econ', `${e.name || e.category} PRINT — LIVE NOW`, e.impact === 'HIGH' ? 'crit' : 'warn', `econ:${e.start_et}:${e.name}`);
        }
      }
    } catch (e) { log('tape econ error:', e.message); }
  }, ECON_MS);

  app.get('/api/tape', (_req, res) => {
    try { res.json({ events: events.slice(0, 80) }); }
    catch (e) { log('tape error:', e.message); res.status(500).json({ error: 'tape unavailable' }); }
  });

  emit('sys', 'TAPE ONLINE — MERGED EMPIRE FEED', 'ok', `boot:${Date.now()}`);
  log('tape installed:', events.length, 'event(s) restored');
  // emit lets sniper/pals/warroom land events here; getEvents feeds the digest
  return { emit, getEvents: () => events };
};
