// pals.js — PA LICENSE WATCHER. Polls the PALS public verification API hourly
// for Drake's RE salesperson license (RS376134) and fires push + tape the
// moment Status flips to Active — that push is the activation-day starting gun
// (MLS/E&O admin → list Jerry's parcel → top-200 letters → sphere blast).
//
// GOTCHA (verified live 07-05): the endpoint is genuinely misspelled server-side
// — "SearchForPersonOrFacilty", no second "i". The correctly-spelled URL 404s.
// Plain JSON POST, no cookies, no recaptcha token needed.
'use strict';

const path = require('path');
const { readJson, writeJson } = require('./util');

const API = 'https://www.pals.pa.gov/api/Search/SearchForPersonOrFacilty';
const STATE_FILE = path.join(__dirname, 'data', 'pals.json');
const DEFAULT_MS = 60 * 60000;
const FIRST_DELAY_MS = 30000;

module.exports = function installPals(app, ctx) {
  const { log, readDirective, push, emit } = ctx;

  let state = { license: null, status: null, checkedAt: null, changedAt: null, error: null };
  const saved = readJson(STATE_FILE);
  if (saved && saved.license) state = saved;

  function save() {
    try { writeJson(STATE_FILE, state, true); }
    catch (e) { log('pals save error:', e.message); }
  }

  async function check() {
    if (typeof fetch !== 'function') { log('pals: node lacks fetch, watcher idle'); return; }
    // everything inside the try — a mid-edit directive.json must not escape a
    // setInterval-driven async fn (unhandled rejection kills the whole process)
    try {
      const cfg = readDirective().pals || {};
      const license = cfg.license || 'RS376134';
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(API, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json;charset=UTF-8' },
        body: JSON.stringify({
          OptPersonFacility: 'Person', LicenseNumber: license, State: '',
          Country: 'ALL', County: null, IsFacility: 0, PersonId: null, PageNo: 1
        })
      });
      clearTimeout(timer);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const rows = await r.json();
      const hit = Array.isArray(rows) ? rows.find(x => x.LicenseNumber === license) : null;
      if (!hit) throw new Error('license not in response');
      const status = String(hit.Status || 'UNKNOWN');
      const prev = state.status;
      state = {
        license, status,
        checkedAt: Date.now(),
        changedAt: (prev && prev !== status) ? Date.now() : state.changedAt,
        error: null
      };
      save();
      if (prev && prev !== status) {
        const active = /active/i.test(status) && !/inactive/i.test(status);
        log('PALS STATUS FLIP:', prev, '->', status);
        if (emit) {
          emit('re', `PALS ${license} → ${status.toUpperCase()}${active ? ' — ACTIVATION DAY. FIRE THE PLAYBOOK.' : ''}`,
            active ? 'hot' : 'warn', `pals:${license}:${status}`);
        }
        if (push) {
          push({
            title: active ? 'PALS — LICENSE ACTIVE' : `PALS — ${status.toUpperCase()}`,
            body: active
              ? `${license} is ACTIVE. Activation-day playbook: MLS/E&O admin → list Jerry's parcel → top-200 letters → sphere blast.`
              : `${license} status changed: ${prev} → ${status}`,
            tag: 'sovereign-pals'
          }).catch(e => log('pals push error:', e.message));
        }
      }
    } catch (e) {
      state.error = e.message;
      state.checkedAt = Date.now();
      save();
      log('pals check error:', e.message);
    }
  }

  const cfg = readDirective().pals || {};
  const everyMs = Math.max(10 * 60000, (cfg.checkMinutes || 60) * 60000);
  setInterval(check, everyMs);
  setTimeout(check, FIRST_DELAY_MS);

  app.get('/api/pals', (_req, res) => {
    try { res.json(state); }
    catch (e) { log('pals error:', e.message); res.status(500).json({ error: 'pals unavailable' }); }
  });

  log('pals installed: watching', cfg.license || 'RS376134', 'every', Math.round(everyMs / 60000), 'min');
};
