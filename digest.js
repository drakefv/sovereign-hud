// digest.js — MORNING BRIEF: 7 AM ET, one Telegram message, already oriented.
// Built from the HUD's own rails (self-HTTP so every cache and normalization
// is reused) + the tape's overnight events. Creds come from bot-army's .env
// (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) read at send time — never stored here.
'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, etParts: etNow } = require('./util');

const STATE_FILE = path.join(__dirname, 'data', 'digest.json');
const TICK_MS = 60000;
const SELF = 'http://127.0.0.1:5300';

// minimal .env parse — only the two TG keys, values never logged
function tgCreds(envFile) {
  try {
    const raw = fs.readFileSync(envFile, 'utf8');
    const grab = k => {
      const m = raw.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm'));
      return m ? m[1].trim() : null;
    };
    // bot-army names the chat id TELEGRAM_OWNER_ID; accept the standard name too
    return { token: grab('TELEGRAM_BOT_TOKEN'), chatId: grab('TELEGRAM_CHAT_ID') || grab('TELEGRAM_OWNER_ID') };
  } catch { return { token: null, chatId: null }; }
}

async function getJson(p) {
  const r = await fetch(SELF + p, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
}
const safe = fn => fn.catch(() => null);

module.exports = function installDigest(app, ctx) {
  const { log, readDirective, getEvents } = ctx;

  let state = { lastSent: null, ...(readJson(STATE_FILE) || {}) };
  function save() {
    try { writeJson(STATE_FILE, state); }
    catch (e) { log('digest save error:', e.message); }
  }

  function fmtCountdown(deadline) {
    const ms = Date.parse(deadline) - Date.now();
    if (!Number.isFinite(ms)) return null;
    if (ms < 0) return 'PAST';
    const h = Math.floor(ms / 3600000);
    return h >= 48 ? null : h >= 24 ? `${Math.floor(h / 24)}D ${h % 24}H` : `${h}H ${Math.floor(ms % 3600000 / 60000)}M`;
  }

  async function build() {
    const dir = readDirective();
    const [nq, keystone, ops, pals, warroom, fleet, sniper] = await Promise.all([
      safe(getJson('/api/nq')), safe(getJson('/api/keystone')), safe(getJson('/api/ops')),
      safe(getJson('/api/pals')), safe(getJson('/api/warroom')), safe(getJson('/api/fleet')),
      safe(getJson('/api/sniper'))
    ]);
    const L = [`SOVEREIGN BRIEF — ${etNow().dateStr}`];

    // countdowns inside 48h
    const clocks = [];
    if (dir.primary && dir.primary.deadline) {
      const c = fmtCountdown(dir.primary.deadline);
      if (c) clocks.push(`${dir.primary.value || dir.primary.label}: ${c}`);
    }
    for (const s of dir.secondary || []) {
      const c = fmtCountdown(s.deadline);
      if (c) clocks.push(`${s.label}: ${c}`);
    }
    if (clocks.length) L.push('', 'ON THE CLOCK', ...clocks.map(c => '· ' + c));

    if (nq) {
      const v = nq.verdict || {};
      const parts = [`NQ: ${v.text || '—'}`];
      if (nq.bias && nq.bias.composite != null) parts.push(`bias ${nq.bias.composite > 0 ? '+' : ''}${nq.bias.composite}`);
      if (warroom && warroom.boot && warroom.boot.result) parts.push(`boot ${warroom.boot.result}`);
      L.push('', parts.join(' · '));
      const fails = warroom ? warroom.items.filter(i => i.state === 'fail') : [];
      if (fails.length) L.push('WAR ROOM FAILS: ' + fails.map(f => f.label).join(', '));
    }
    if (keystone) {
      L.push(`KEYSTONE: ${keystone.sent} sent · EV $${keystone.evUsd} · batch ${keystone.batchSent}/${keystone.batchTotal}`);
      const r = sniper && sniper.replies && sniper.replies[0];
      if (r && Date.now() - r.at < 24 * 3600000) L.push(`REPLY LANDED: ${r.name} (${r.category})${r.ad ? ' — ad ready' : ''}`);
    }
    if (pals && pals.status) L.push(`PALS ${pals.license}: ${pals.status.toUpperCase()}`);
    if (ops) {
      L.push(`OPS: gold jrnl ${ops.journal.gold}/${ops.journal.gate} · probate ${ops.re.probate ?? '—'} · top-200 ${ops.re.mailable ?? '—'}`);
    }
    if (fleet) {
      const down = fleet.filter(p => p.status !== 'online' && p.status !== 'stopped');
      L.push(`FLEET: ${fleet.filter(p => p.status === 'online').length}/${fleet.length} online${down.length ? ' · ATTN ' + down.map(p => p.name).join(',') : ''}`);
    }

    // overnight tape: crit/hot first, last 12h, max 8
    const since = Date.now() - 12 * 3600000;
    const evs = (getEvents ? getEvents() : []).filter(e => e.t > since);
    const rank = { crit: 0, hot: 1, warn: 2, ok: 3, flow: 4, info: 5 };
    const top = evs.sort((a, b) => (rank[a.cls] ?? 9) - (rank[b.cls] ?? 9) || b.t - a.t).slice(0, 8);
    if (top.length) L.push('', 'OVERNIGHT TAPE', ...top.map(e => '· ' + e.msg));

    return L.join('\n');
  }

  async function sendBrief(label) {
    const cfg = readDirective().digest || {};
    const { token, chatId } = tgCreds(cfg.envFile || 'C:/Users/Drake/bot-army/.env');
    if (!token || !chatId) throw new Error('TG creds missing in envFile');
    const text = await build();
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(20000)
    });
    if (!r.ok) throw new Error('telegram ' + r.status);
    log('digest sent —', label);
  }

  async function tick() {
    try {
      const cfg = readDirective().digest || {};
      if (cfg.enabled === false) return;
      const hourEt = cfg.hourEt != null ? cfg.hourEt : 7;
      const t = etNow();
      if (t.hour !== hourEt || state.lastSent === t.dateStr) return;
      state.lastSent = t.dateStr; // claim the slot first — a TG outage must not re-fire every minute for an hour
      save();
      await sendBrief('daily ' + t.dateStr);
    } catch (e) { log('digest tick error:', e.message); }
  }
  setInterval(tick, TICK_MS);

  // manual fire — PIN-gated like /api/push/test; does NOT consume the daily slot
  app.post('/api/digest/send', async (req, res) => {
    try {
      const pin = (readDirective().action || {}).pin;
      if (!pin || String((req.body || {}).pin) !== String(pin)) return res.status(403).json({ error: 'bad pin' });
      await sendBrief('manual');
      res.json({ ok: true });
    } catch (e) { log('digest send error:', e.message); res.status(500).json({ error: e.message }); }
  });

  // preview rail — read the brief without sending it
  app.get('/api/digest/preview', async (_req, res) => {
    try { res.json({ text: await build(), lastSent: state.lastSent }); }
    catch (e) { log('digest preview error:', e.message); res.status(500).json({ error: 'digest unavailable' }); }
  });

  log('digest installed: daily brief at', ((readDirective().digest || {}).hourEt ?? 7) + ':00 ET');
};
