// push.js — web-push uplink: the HUD stops being pull-only.
// Server-side watcher evaluates defcon independently of any open browser tab,
// pushes on escalation, re-pings hourly while red, and sends one ALL CLEAR on recovery.
'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const NQ_DIR = 'C:/Users/Drake/nq-bot';
const VAPID_FILE = path.join(__dirname, 'data', 'vapid.json');
const SUBS_FILE = path.join(__dirname, 'data', 'push-subs.json');
const WATCH_MS = 45000;
const REPING_MS = 60 * 60000;

module.exports = function installPush(app, ctx) {
  const { log, readDirective, readJsonSafe, lastJsonlLine, getPm2 } = ctx;

  let vapid;
  try { vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')); }
  catch (e) { log('push disabled — vapid.json missing:', e.message); return { send: null }; }
  // VAPID contact — the address a push service operator would use to reach you.
  // Real value lives in gitignored directive.json; public code carries a placeholder.
  const contact = (readDirective().push || {}).contactEmail || 'admin@example.com';
  webpush.setVapidDetails('mailto:' + contact, vapid.publicKey, vapid.privateKey);

  let subs = [];
  try { subs = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch { /* none yet */ }
  function saveSubs() {
    try {
      fs.mkdirSync(path.dirname(SUBS_FILE), { recursive: true });
      fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2));
    } catch (e) { log('push subs save error:', e.message); }
  }

  app.get('/api/push/pubkey', (_req, res) => res.json({ key: vapid.publicKey, subs: subs.length }));

  app.post('/api/push/subscribe', (req, res) => {
    try {
      const sub = req.body;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
        return res.status(400).json({ error: 'bad subscription' });
      }
      subs = subs.filter(s => s.endpoint !== sub.endpoint);
      subs.push(sub);
      saveSubs();
      log('push: subscriber added, total', subs.length);
      res.json({ ok: true, subs: subs.length });
    } catch (e) { log('push subscribe error:', e.message); res.status(500).json({ error: 'subscribe failed' }); }
  });

  async function send(payload) {
    const body = JSON.stringify(payload);
    const dead = [];
    await Promise.all(subs.map(async s => {
      try { await webpush.sendNotification(s, body); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.endpoint);
        else log('push send error:', e.statusCode || e.message);
      }
    }));
    if (dead.length) { subs = subs.filter(s => !dead.includes(s.endpoint)); saveSubs(); }
  }

  app.post('/api/push/test', async (req, res) => {
    try {
      const pin = (readDirective().action || {}).pin;
      if (!pin || String((req.body || {}).pin) !== String(pin)) return res.status(403).json({ error: 'bad pin' });
      await send({ title: 'SOVEREIGN — UPLINK TEST', body: 'Push channel live. The room can reach you now.', tag: 'sovereign-test' });
      res.json({ ok: true, subs: subs.length });
    } catch (e) { log('push test error:', e.message); res.status(500).json({ error: 'test failed' }); }
  });

  /* ---- independent watcher: works with every browser tab closed ---- */
  let lastActive = new Set();
  const lastSentAt = new Map();
  let lastLevel = 'ok';

  async function evaluate() {
    const found = new Map(); // key -> {msg, crit}
    const dir = readDirective();
    try {
      // shared snapshot — this used to fork its own pm2 jlist every 45s
      const procs = (await getPm2(WATCH_MS)).map(p =>
        ({ name: p.name, status: p.pm2_env.status, restarts: p.pm2_env.restart_time }));
      for (const w of dir.watchlist || []) {
        const p = procs.find(f => f.name === w.process);
        if (w.expect === 'stopped' && p && p.status === 'online') {
          found.set(`watch:${w.process}`, { msg: `${w.process} ONLINE but expected STOPPED — ${w.reason}`, crit: true });
        }
        if (w.expect === 'online' && (!p || p.status !== 'online')) {
          found.set(`watch:${w.process}`, { msg: `${w.process} DOWN but expected ONLINE — ${w.reason}`, crit: true });
        }
      }
      for (const p of procs) {
        if (p.status === 'errored') found.set(`err:${p.name}`, { msg: `${p.name} ERRORED in pm2`, crit: true });
        else if (p.status === 'online' && p.restarts > ((dir.thresholds || {}).restartAlert || 8)) {
          found.set(`hot:${p.name}`, { msg: `${p.name} restart count ${p.restarts}`, crit: false });
        }
      }
    } catch (e) { log('push watcher pm2 error:', e.message); }
    try {
      const flags = readJsonSafe(path.join(NQ_DIR, 'data/strategy_pause_flags.json'));
      const circuit = readJsonSafe(path.join(NQ_DIR, 'data/circuit_state.json'));
      if (flags && flags.portfolio_kill) found.set('nq:kill', { msg: `NQ PORTFOLIO KILL — ${flags.kill_reason || 'manual'}`, crit: true });
      if (circuit && circuit.tripped) found.set('nq:circuit', { msg: `NQ CIRCUIT TRIPPED — ${circuit.trip_reason || ''}`, crit: true });
      const pnl = lastJsonlLine(path.join(NQ_DIR, 'data/multi_firm_pnl.jsonl'));
      const acct = pnl ? (Object.values(pnl.firms || {}).flat()[0] || null) : null;
      if (acct && acct.lock_state && acct.lock_state !== 'open') {
        found.set('nq:lock', { msg: `NQ ACCOUNT ${String(acct.lock_state).toUpperCase()} — ${acct.lock_reason || ''}`, crit: true });
      }
    } catch (e) { log('push watcher nq error:', e.message); }
    return found;
  }

  async function tick() {
    try {
      if (!subs.length) return;
      const found = await evaluate();
      const level = [...found.values()].some(f => f.crit) ? 'crit' : found.size ? 'warn' : 'ok';
      const now = Date.now();
      const fresh = [], reping = [];
      for (const [key, f] of found) {
        const isNew = !lastActive.has(key);
        const stale = now - (lastSentAt.get(key) || 0) > REPING_MS;
        if (isNew && stale) { fresh.push(f); lastSentAt.set(key, now); }
        else if (f.crit && stale) { reping.push(f); lastSentAt.set(key, now); }
      }
      const toSend = fresh.length ? fresh : reping;
      if (toSend.length) {
        const crit = toSend.some(f => f.crit);
        await send({
          title: crit ? 'SOVEREIGN — DEFCON RED' : 'SOVEREIGN — DEFCON AMBER',
          body: toSend.map(f => f.msg).slice(0, 4).join('\n'),
          tag: 'sovereign-defcon'
        });
        log('push: sent', crit ? 'RED' : 'AMBER', '·', toSend.length, 'alerts');
      }
      if (level === 'ok' && lastLevel === 'crit') {
        await send({ title: 'SOVEREIGN — ALL CLEAR', body: 'Room repainted green. All rails nominal.', tag: 'sovereign-defcon' });
        log('push: sent ALL CLEAR');
      }
      lastActive = new Set(found.keys());
      lastLevel = level;
    } catch (e) { log('push tick error:', e.message); }
  }
  setInterval(tick, WATCH_MS);

  log('push installed:', subs.length, 'subscriber(s)');
  // send is the shared uplink — sniper/pals/warroom fire through it
  return { send };
};
