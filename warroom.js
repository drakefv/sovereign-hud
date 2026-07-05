// warroom.js — MONDAY WAR ROOM: the 9:25 boot, verified instead of hoped-for.
// Continuously evaluates a boot checklist during market hours (daemon task,
// watchdog, strat-log pulse, bias published, guards, close-time-stop armed,
// leader seatbelt) and fires ONE boot verdict push at 9:32 ET — RED with the
// failing items, or BOOT CLEAN. Separately confirms close-time-stop actually
// FIRED at 11:35 (it was silently disabled for 4 days once; never again).
// NOTE: weekday check is holiday-blind, same as the bot_died alert — on CME
// holidays expect PEND/FAIL noise here, not a real miss.
'use strict';

const path = require('path');
const { fileAgeMin, readJson, writeJson, etParts: et } = require('./util');

const NQ_DIR = 'C:/Users/Drake/nq-bot';
const STATE_FILE = path.join(__dirname, 'data', 'warroom.json');
const TICK_MS = 30000;
const EVAL_CACHE_MS = 15000;
// task names live in directive.json (warroom key) — these are only the defaults
const TASK_DEFAULTS = { daemonTask: 'run-live-daemon', watchdogTask: 'run-live-watchdog', timeStopTask: 'close-time-stop' };

const M = (h, m) => h * 60 + m;

module.exports = function installWarroom(app, ctx) {
  const { log, readJsonSafe, readDirective, getTasks, nqVerdict, push, emit } = ctx;

  let state = { bootDate: null, bootResult: null, timeStopDate: null };
  state = { ...state, ...(readJson(STATE_FILE) || {}) };
  function save() {
    try { writeJson(STATE_FILE, state, true); }
    catch (e) { log('warroom save error:', e.message); }
  }

  const taskNames = () => ({ ...TASK_DEFAULTS, ...(readDirective().warroom || {}) });

  async function evaluate() {
    const t = et();
    const phase = !t.weekday ? 'WEEKEND'
      : t.minutes < M(9, 25) ? 'PRE-MARKET'
      : t.minutes < M(9, 35) ? 'BOOT WINDOW'
      : t.minutes <= M(16, 15) ? 'SESSION' : 'AFTER HOURS';
    const items = [];
    const it = (key, label, stateStr, detail) => items.push({ key, label, state: stateStr, detail: detail || '' });
    // 9:30 lower bound (not 9:35): daemon boots 9:25, so by the 9:32 boot
    // verdict RUNNING must already be observable or the check is decorative
    const inSession = t.weekday && t.minutes >= M(9, 30) && t.minutes <= M(16, 15);

    // scheduled tasks: daemon + watchdog must be RUNNING in session, armed otherwise
    const names = taskNames();
    let tasks = [];
    try { tasks = await getTasks(60000); } catch (e) { log('warroom tasks error:', e.message); }
    const tstate = name => (tasks.find(x => x.name === name) || {}).state || 'missing';
    for (const [key, name] of [['daemon', names.daemonTask], ['watchdog', names.watchdogTask]]) {
      const s = tstate(name);
      if (s === 'missing') it(key, name.toUpperCase(), 'fail', 'TASK NOT FOUND');
      else if (s === 'disabled') it(key, name.toUpperCase(), 'fail', 'DISABLED');
      else if (inSession) it(key, name.toUpperCase(), s === 'running' ? 'pass' : 'fail', s.toUpperCase());
      else it(key, name.toUpperCase(), 'pass', `${s.toUpperCase()} — ARMED`);
    }
    const ts = tstate(names.timeStopTask);
    it('timestop', 'CLOSE-TIME-STOP', (ts === 'missing' || ts === 'disabled') ? 'fail' : 'pass',
      ts === 'missing' ? 'TASK NOT FOUND' : ts.toUpperCase() + ' · FIRES 11:30');

    // bias published for today
    const bias = readJsonSafe(path.join(NQ_DIR, 'data/phase_s_daily.json'));
    const biasToday = bias && bias.asof_date === t.dateStr;
    it('bias', 'BIAS PUBLISHED', biasToday ? 'pass' : (t.weekday && t.minutes >= M(9, 25)) ? 'fail' : 'pend',
      bias ? `ASOF ${bias.asof_date}` : 'NO FILE');

    // guards: LOCKED is the only failure — SKIP DAY is a verdict, not a fault.
    // account lock included: same three-way rule as the /api/nq badge
    const flags = readJsonSafe(path.join(NQ_DIR, 'data/strategy_pause_flags.json'));
    const circuit = readJsonSafe(path.join(NQ_DIR, 'data/circuit_state.json'));
    const pnl = ctx.lastJsonlLine(path.join(NQ_DIR, 'data/multi_firm_pnl.jsonl'));
    const acct = pnl ? (Object.values(pnl.firms || {}).flat()[0] || null) : null;
    const v = nqVerdict.fromBiasFile(bias,
      { portfolioKill: !!(flags && flags.portfolio_kill), circuitTripped: !!(circuit && circuit.tripped) },
      acct && { lockState: acct.lock_state });
    it('guards', 'GUARDS', v.cls === 'locked' ? 'fail' : 'pass', v.text);

    // strat-log pulse: the honest liveness signal (heartbeat file is stale-forever)
    const pulseAge = fileAgeMin(path.join(NQ_DIR, `logs/run_strategy_${t.dateStr}.log`));
    const pulseWindow = t.weekday && t.minutes >= M(9, 27) && t.minutes <= M(16, 15);
    it('pulse', 'STRAT PULSE',
      !pulseWindow ? 'pend' : pulseAge != null && pulseAge <= 5 ? 'pass' : 'fail',
      pulseAge == null ? 'NO LOG TODAY' : `${Math.round(pulseAge)}M AGO`);

    // leader seatbelt: kill-switch guard cycle freshness, market hours only
    const ks = readJsonSafe(path.join(NQ_DIR, 'data_50k/kill_switch_state.json'));
    const ksAge = ks && ks.updated_iso ? (Date.now() - Date.parse(ks.updated_iso)) / 60000 : null;
    const beltWindow = t.weekday && t.minutes >= M(9, 30) && t.minutes <= M(16, 15);
    it('belt', 'LEADER SEATBELT',
      !beltWindow ? 'pend' : ksAge != null && ksAge <= 10 ? 'pass' : 'fail',
      ksAge == null ? 'NO GUARD STATE' : `${Math.round(ksAge)}M AGO`);

    return { phase, etDate: t.dateStr, items, boot: { date: state.bootDate, result: state.bootResult } };
  }

  // memo: tick (30s) + /api/warroom + digest all evaluate — one pass serves them all
  let evalCache = { at: 0, promise: null };
  function evaluateCached() {
    if (Date.now() - evalCache.at < EVAL_CACHE_MS && evalCache.promise) return evalCache.promise;
    const p = evaluate().catch(err => {
      if (evalCache.promise === p) evalCache.promise = null; // never cache a rejection
      throw err;
    });
    evalCache = { at: Date.now(), promise: p };
    return p;
  }

  /* ---- boot verdict: once per weekday at 9:32 ET ---- */
  async function tick() {
    try {
      const t = et();
      if (!t.weekday) return;

      if (t.minutes >= M(9, 32) && state.bootDate !== t.dateStr) {
        // claim the day only AFTER a successful evaluate — a transient failure
        // here must retry next tick, not silently eat the day's boot verdict
        const ev = await evaluateCached();
        state.bootDate = t.dateStr;
        // pend items don't block boot — only hard fails on the boot-critical five
        const bootKeys = ['daemon', 'watchdog', 'pulse', 'bias', 'timestop'];
        const fails = ev.items.filter(i => bootKeys.includes(i.key) && i.state === 'fail');
        state.bootResult = fails.length ? 'MISSED' : 'CLEAN';
        save();
        if (fails.length) {
          const detail = fails.map(f => `${f.label}: ${f.detail}`).join('\n');
          if (emit) emit('war', `BOOT MISSED — ${fails.map(f => f.label).join(', ')}`, 'crit', `boot:${t.dateStr}`);
          if (push) push({ title: 'WAR ROOM — BOOT MISSED', body: detail, tag: 'sovereign-warroom' })
            .catch(e => log('warroom push error:', e.message));
          log('WARROOM: BOOT MISSED —', fails.map(f => f.label).join(','));
        } else {
          if (emit) emit('war', 'BOOT CLEAN — 9:25 SEQUENCE VERIFIED, ALL RAILS ARMED', 'ok', `boot:${t.dateStr}`);
          if (push) push({ title: 'WAR ROOM — BOOT CLEAN', body: 'Daemon up, pulse fresh, bias live, time-stop armed.', tag: 'sovereign-warroom' })
            .catch(e => log('warroom push error:', e.message));
          log('WARROOM: BOOT CLEAN');
        }
      }

      // 11:35: confirm close-time-stop actually FIRED (11:30 window close on leader)
      if (t.minutes >= M(11, 35) && state.timeStopDate !== t.dateStr) {
        state.timeStopDate = t.dateStr;
        save();
        try {
          // Get-ScheduledTask pipe (not Get-ScheduledTaskInfo -TaskName): the
          // task lives under \nq-bot\, and the direct form only searches root
          const out = await ctx.run(
            `powershell -NoProfile -Command "Get-ScheduledTask -TaskName '${taskNames().timeStopTask}' | Get-ScheduledTaskInfo | Select-Object LastRunTime,LastTaskResult | ConvertTo-Json -Compress"`,
            20000);
          const info = JSON.parse(out);
          // .NET date serializes as /Date(ms)/ under ConvertTo-Json depth default
          const ms = typeof info.LastRunTime === 'string'
            ? (info.LastRunTime.match(/\d{10,}/) ? +info.LastRunTime.match(/\d{10,}/)[0] : Date.parse(info.LastRunTime))
            : null;
          const ranToday = ms && new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === t.dateStr;
          if (ranToday && info.LastTaskResult === 0) {
            if (emit) emit('war', 'TIME-STOP FIRED — 11:30 WINDOW CLOSE CONFIRMED · EXIT 0', 'ok', `tsp:${t.dateStr}`);
          } else {
            if (emit) emit('war', `TIME-STOP DID NOT FIRE TODAY${info.LastTaskResult != null ? ` · LAST EXIT ${info.LastTaskResult}` : ''}`, 'crit', `tsp:${t.dateStr}`);
            if (push) push({ title: 'WAR ROOM — TIME-STOP MISSED', body: 'close-time-stop shows no run today. Check the leader position window NOW.', tag: 'sovereign-warroom' })
              .catch(e => log('warroom push error:', e.message));
          }
        } catch (e) { log('warroom timestop check error:', e.message); }
      }
    } catch (e) { log('warroom tick error:', e.message); }
  }
  setInterval(tick, TICK_MS);

  app.get('/api/warroom', async (_req, res) => {
    try { res.json(await evaluateCached()); }
    catch (e) { log('warroom error:', e.message); res.status(500).json({ error: 'warroom unavailable' }); }
  });

  log('warroom installed: boot verdict 9:32 ET · time-stop audit 11:35 ET');
};
