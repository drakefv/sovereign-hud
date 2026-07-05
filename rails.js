// rails.js — second-wave read rails + the HUD's first write surface (pm2 restart).
// Additive module: server.js stays the orchestrator, this owns the 07-04 batch.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const MEME_DATA = 'C:/Users/Drake/meme-radar/data';
const TL_LOGS = 'C:/Users/Drake/tradelocker-bot/logs';
const SF_OUT = 'C:/Users/Drake/seller-finder/out';
const NQ_PNL = 'C:/Users/Drake/nq-bot/data/multi_firm_pnl.jsonl';
const BOT_ARMY_DATA = 'C:/Users/Drake/bot-army/data';
const VOICE_NOTES = 'C:/Users/Drake/Obsidian/08 - Claude Memory/Voice Notes.md';

const FLOWQ_CACHE_MS = 30000;
const KEYSTONE_CACHE_MS = 30000;
const OPS_CACHE_MS = 60000;
const LEDGER_CACHE_MS = 60000;
const LYDIA_CACHE_MS = 60000;
const ACTION_COOLDOWN_MS = 5000;
const HEARTBEAT_MS = 60000;
const LEDGER_MAX_POINTS = 400;

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
const dayStr = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

module.exports = function installRails(app, ctx) {
  const { run, log, readDirective, readJsonSafe, spark } = ctx;
  const cached = (store, ms, build) => {
    if (Date.now() - store.at < ms && store.data) return store.data;
    store.data = build();
    store.at = Date.now();
    return store.data;
  };

  /* ---- meme flow-quality: who's-buying metrics on clean-2x fires ---- */
  const flowqCache = { at: 0, data: null };
  function buildFlowq() {
    const rows = [...readJsonl(path.join(MEME_DATA, `flowq-${dayStr(0)}.jsonl`)),
                  ...readJsonl(path.join(MEME_DATA, `flowq-${dayStr(1)}.jsonl`))]
      .sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
    const today = rows.filter(r => r.t && r.t.slice(0, 10) === dayStr(0));
    const buyers = today.map(r => r.uniqueBuyers || 0).sort((a, b) => a - b);
    return {
      firesToday: today.length,
      medBuyers: buyers.length ? buyers[Math.floor(buyers.length / 2)] : null,
      saturated: today.filter(r => r.saturated).length,
      recent: rows.slice(0, 8).map(r => ({
        t: r.t, mint: r.mint, minSince: r.minSince, trigMult: r.trigMult,
        mcap: r.mcapAtTrig, buyers: r.uniqueBuyers, sol: r.totalBuySol,
        top1: r.top1Share, devTxs: r.devTxs
      }))
    };
  }
  app.get('/api/flowq', (_req, res) => {
    try { res.json(cached(flowqCache, FLOWQ_CACHE_MS, buildFlowq)); }
    catch (e) { log('flowq error:', e.message); flowqCache.data ? res.json(flowqCache.data) : res.status(503).json({ error: 'flowq unavailable' }); }
  });
  // flow spark: fires-per-day curve, sampled alongside the other rings
  setInterval(() => {
    try {
      const d = cached(flowqCache, FLOWQ_CACHE_MS, buildFlowq);
      spark.flow = spark.flow || [];
      spark.flow.push(d.firesToday);
      if (spark.flow.length > 96) spark.flow.shift();
    } catch (e) { log('spark flow error:', e.message); }
  }, 300000);

  /* ---- keystone pipeline: outreach drafts x prospect batch x reply watch ---- */
  const keystoneCache = { at: 0, data: null };
  function buildKeystone() {
    const dir = readDirective();
    const drafts = (readJsonSafe(path.join(BOT_ARMY_DATA, 'email-drafts.json')) || {}).drafts || [];
    const sent = drafts.filter(d => d.status === 'sent');
    const sentEmails = new Set(sent.map(d => (d.email || '').toLowerCase()));
    let batchTotal = 0, batchSent = 0;
    try {
      const md = fs.readFileSync((dir.keystone && dir.keystone.batchFile) || '', 'utf8');
      for (const m of md.matchAll(/^## \d+\.\s*(.+?)\s+—\s+(\S+)\s*$/gm)) {
        batchTotal++;
        if (sentEmails.has(m[2].toLowerCase())) batchSent++;
      }
    } catch { /* batch file missing */ }
    const replyState = readJsonSafe(path.join(BOT_ARMY_DATA, 'email-reply-state.json'));
    const ev = (dir.keystone && dir.keystone.evPerEmail) || 80;
    return {
      sent: sent.length,
      pending: drafts.filter(d => d.status === 'pending').length,
      rejected: drafts.filter(d => d.status === 'rejected').length,
      batchTotal, batchSent,
      evUsd: sent.length * ev, evPerEmail: ev,
      lastUid: replyState ? replyState.lastUid : null,
      recent: drafts.slice(-6).reverse().map(d => ({ name: d.businessName, status: d.status, at: d.decidedAt || d.createdAt }))
    };
  }
  app.get('/api/keystone', (_req, res) => {
    try { res.json(cached(keystoneCache, KEYSTONE_CACHE_MS, buildKeystone)); }
    catch (e) { log('keystone error:', e.message); keystoneCache.data ? res.json(keystoneCache.data) : res.status(503).json({ error: 'keystone unavailable' }); }
  });

  /* ---- ops: TL journal gate + real-estate lead rails ---- */
  const opsCache = { at: 0, data: null };
  function csvRows(p) {
    try { return Math.max(0, fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).length - 1); }
    catch { return null; }
  }
  function buildOps() {
    let journalN = 0, goldN = 0;
    try {
      for (const f of fs.readdirSync(TL_LOGS)) {
        if (!/^outcomes_\d{8}\.jsonl$/.test(f)) continue;
        for (const r of readJsonl(path.join(TL_LOGS, f))) {
          if (r.kind === 'journal' || r.source === 'journal') {
            journalN++;
            if (/xau|gold/i.test(r.symbol || '')) goldN++;
          }
        }
      }
    } catch (e) { log('ops journal error:', e.message); }
    const open = readJsonSafe(path.join(TL_LOGS, 'journal_open.json')) || {};
    return {
      journal: { total: journalN, gold: goldN, open: Object.keys(open).length, gate: 20 },
      re: { probate: csvRows(path.join(SF_OUT, 'probate_leads.csv')), mailable: csvRows(path.join(SF_OUT, 'top_200_mailable.csv')) }
    };
  }
  app.get('/api/ops', (_req, res) => {
    try { res.json(cached(opsCache, OPS_CACHE_MS, buildOps)); }
    catch (e) { log('ops error:', e.message); opsCache.data ? res.json(opsCache.data) : res.status(503).json({ error: 'ops unavailable' }); }
  });

  /* ---- ledger: full equity curve off multi_firm_pnl.jsonl ---- */
  const ledgerCache = { at: 0, data: null };
  function buildLedger() {
    const pts = [];
    for (const row of readJsonl(NQ_PNL)) {
      // firm key order varies across eras — pin to the 150k practice series
      const firms = row.firms || {};
      const acct = (firms['150k'] || []).concat(Object.values(firms).flat())[0];
      if (!acct || !row.ts) continue;
      const bal = +acct.current_balance_usd, real = row.totals ? +row.totals.realized_pnl_usd : null;
      if (!Number.isFinite(bal)) continue;
      pts.push({ t: Date.parse(row.ts), bal, real: Number.isFinite(real) ? real : 0 });
    }
    pts.sort((a, b) => a.t - b.t);
    const stride = Math.max(1, Math.ceil(pts.length / LEDGER_MAX_POINTS));
    const out = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
    return { points: out, lastTs: pts.length ? pts[pts.length - 1].t : null };
  }
  app.get('/api/ledger', (_req, res) => {
    try { res.json(cached(ledgerCache, LEDGER_CACHE_MS, buildLedger)); }
    catch (e) { log('ledger error:', e.message); ledgerCache.data ? res.json(ledgerCache.data) : res.status(503).json({ error: 'ledger unavailable' }); }
  });

  /* ---- lydia: voice-note bridge (read-only, her one write surface) ---- */
  const lydiaCache = { at: 0, data: null };
  function buildLydia() {
    let noteAgeMin = null, tail = '';
    try {
      noteAgeMin = Math.round((Date.now() - fs.statSync(VOICE_NOTES).mtimeMs) / 60000);
      const lines = fs.readFileSync(VOICE_NOTES, 'utf8').split('\n').filter(l => l.trim());
      tail = lines.slice(-6).join('\n').replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '');
    } catch { /* vault offline */ }
    return { noteAgeMin, tail };
  }
  app.get('/api/lydia', (_req, res) => {
    try { res.json(cached(lydiaCache, LYDIA_CACHE_MS, buildLydia)); }
    catch (e) { log('lydia error:', e.message); res.status(503).json({ error: 'lydia unavailable' }); }
  });

  /* ---- action rail v1: pm2 restart, allowlisted + PIN + cooldown ---- */
  let lastActionAt = 0;
  app.post('/api/action/restart', async (req, res) => {
    try {
      const dir = readDirective();
      const cfg = dir.action || {};
      const { name, pin } = req.body || {};
      if (!cfg.pin) return res.status(403).json({ error: 'action rail disabled (no pin in directive.json)' });
      if (String(pin) !== String(cfg.pin)) { log('ACTION DENIED bad pin for', name); return res.status(403).json({ error: 'bad pin' }); }
      if (typeof name !== 'string' || !/^[\w-]{1,64}$/.test(name)) return res.status(400).json({ error: 'bad process name' });
      if (!Array.isArray(cfg.allow) || !cfg.allow.includes(name)) { log('ACTION DENIED not allowlisted:', name); return res.status(403).json({ error: `${name} not in action.allow` }); }
      if (Date.now() - lastActionAt < ACTION_COOLDOWN_MS) return res.status(429).json({ error: 'cooling down' });
      lastActionAt = Date.now();
      log('ACTION pm2 restart', name);
      await run(`pm2 restart ${name} --update-env`, 30000);
      res.json({ ok: true, name });
    } catch (e) {
      log('action error:', e.message);
      res.status(500).json({ error: 'restart failed — check pm2' });
    }
  });

  /* ---- dead-man heartbeat: push liveness OUT so an external observer can page ---- */
  let hbState = 'init';
  setInterval(async () => {
    try {
      const url = readDirective().heartbeatUrl;
      if (!url) { if (hbState !== 'off') { hbState = 'off'; } return; }
      if (typeof fetch !== 'function') { if (hbState !== 'nofetch') { hbState = 'nofetch'; log('heartbeat: node lacks fetch, skipping'); } return; }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: os.hostname(), ts: new Date().toISOString() })
      });
      clearTimeout(timer);
      if (hbState !== 'ok' && r.ok) { hbState = 'ok'; log('heartbeat: linked to', url); }
      if (!r.ok && hbState !== 'err') { hbState = 'err'; log('heartbeat: beacon rejected', r.status); }
    } catch (e) {
      if (hbState !== 'err') { hbState = 'err'; log('heartbeat error:', e.message); }
    }
  }, HEARTBEAT_MS);

  log('rails installed: flowq keystone ops ledger lydia action heartbeat');
};
