// sniper.js — KEYSTONE REPLY SNIPER. The whole prospect batch is reply bait;
// the reply IS the conversion moment. emailReplyBot (bot-army) already
// classifies every inbox reply and logs matched ones to interactions.json —
// this module watches that file, enriches with business name + the rendered
// Caught-ad MP4 for that prospect, then fires web-push + tape so the moment
// hits Drake's phone with the ammo attached.
'use strict';

const fs = require('fs');
const path = require('path');

const BOT_ARMY_DATA = 'C:/Users/Drake/bot-army/data';
const INTERACTIONS = path.join(BOT_ARMY_DATA, 'tables', 'interactions.json');
const BUSINESSES = path.join(BOT_ARMY_DATA, 'tables', 'businesses.json');
const STATE_FILE = path.join(__dirname, 'data', 'sniper.json');
const SAMPLE_MS = 45000;
const MAX_REPLIES = 20;

const { fileSig, readJson, writeJson } = require('./util');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

module.exports = function installSniper(app, ctx) {
  const { log, readDirective, readJsonSafe, push, emit } = ctx;

  let state = { seen: [], replies: [] };
  const saved = readJson(STATE_FILE);
  if (saved && Array.isArray(saved.seen)) state = saved;
  const seen = new Set(state.seen);

  function save() {
    // keep EVERY processed reply id — the set grows by one per actual reply (rare),
    // and interactions.json is never pruned, so a bounded set would re-fire old
    // replies as "new" after a restart once lifetime replies exceed the cap
    try { writeJson(STATE_FILE, { seen: [...seen], replies: state.replies }); }
    catch (e) { log('sniper save error:', e.message); }
  }

  // prospect batch: "## N. Name — email" + "Ad: caught-....mp4" from emails.md.
  // mtime-gated parse; the ad line is the payoff — reply arrives, MP4 is ready.
  let batchSig = null, batch = [];
  function getBatch() {
    const file = ((readDirective().keystone || {}).batchFile) || '';
    const sig = fileSig(file);
    if (sig === batchSig) return batch;
    batchSig = sig;
    batch = [];
    try {
      const md = fs.readFileSync(file, 'utf8');
      const heads = [...md.matchAll(/^## \d+\.\s*(.+?)\s+—\s+(\S+)\s*$/gm)];
      for (let i = 0; i < heads.length; i++) {
        const seg = md.slice(heads[i].index, heads[i + 1] ? heads[i + 1].index : md.length);
        const ad = (seg.match(/^Ad:\s*(\S+\.mp4)\s*$/m) || [])[1] || null;
        batch.push({ name: heads[i][1], email: heads[i][2].toLowerCase(), ad });
      }
    } catch { /* batch file missing */ }
    return batch;
  }

  function findAd(businessName, fromAddress) {
    const b = getBatch();
    const em = String(fromAddress || '').toLowerCase();
    const byEmail = b.find(p => p.email === em);
    if (byEmail && byEmail.ad) return byEmail.ad;
    const bn = norm(businessName);
    if (!bn) return null;
    const byName = b.find(p => { const pn = norm(p.name); return pn && (pn.includes(bn) || bn.includes(pn)); });
    return byName ? byName.ad : null;
  }

  /* ---- sampler: new email_reply rows in bot-army's interactions table ---- */
  let bizSig = null, bizCache = [];
  function getBusinesses() {
    const sig = fileSig(BUSINESSES);
    if (sig !== bizSig) { bizSig = sig; bizCache = readJsonSafe(BUSINESSES) || []; }
    return bizCache;
  }
  let intSig = null;
  function sample() {
    try {
      const sig = fileSig(INTERACTIONS);
      if (sig === intSig) return;
      intSig = sig;
      const rows = readJsonSafe(INTERACTIONS) || [];
      const businesses = getBusinesses();
      let dirty = false;
      for (const r of rows) {
        if (r.type !== 'email_reply' || !r.id || seen.has(r.id)) continue;
        seen.add(r.id);
        // notes format from emailReplyBot._logReply: "CATEGORY <- from | subject"
        const m = String(r.notes || '').match(/^(\w+)\s*<-\s*([^|]+?)\s*\|\s*(.*)$/);
        const category = m ? m[1] : (r.outcome || 'REPLY').toUpperCase();
        const from = m ? m[2].trim() : '';
        const subject = m ? m[3].trim() : '';
        const biz = businesses.find(b => b.id === r.business_id);
        const name = (biz && biz.name) || from || 'UNKNOWN';
        const ad = findAd(name, (biz && biz.email) || from);
        const reply = { at: Date.now(), date: r.date, name, category, from, subject, ad };
        state.replies.unshift(reply);
        if (state.replies.length > MAX_REPLIES) state.replies.length = MAX_REPLIES;
        dirty = true;
        const good = category === 'INTERESTED' || category === 'UNKNOWN';
        if (emit) {
          emit('keystone', `REPLY ${category} — ${name}${subject ? ` · "${subject.slice(0, 60)}"` : ''}${ad ? ' · AD READY' : ''}`,
            good ? 'hot' : 'warn', `snipe:${r.id}`);
        }
        if (good && push) {
          push({
            title: `KEYSTONE REPLY — ${name}`,
            body: `${category}${subject ? ` · ${subject}` : ''}${ad ? `\nAD READY: ${ad} — open HUD to grab it` : ''}`,
            tag: 'sovereign-sniper'
          }).catch(e => log('sniper push error:', e.message));
        }
        log('SNIPER: reply captured —', name, category);
      }
      if (dirty) save();
    } catch (e) { log('sniper sample error:', e.message); }
  }
  setInterval(sample, SAMPLE_MS);
  setTimeout(sample, 5000);

  /* ---- rails ---- */
  app.get('/api/sniper', (_req, res) => {
    try {
      res.json({ replies: state.replies, batch: getBatch().map(p => ({ name: p.name, ad: p.ad })) });
    } catch (e) { log('sniper error:', e.message); res.status(500).json({ error: 'sniper unavailable' }); }
  });

  // one-tap ammo: stream the prospect's rendered Caught ad to the phone.
  // Strict filename shape — no separators, no traversal, must exist in adDir.
  app.get('/api/sniper/ad/:file', (req, res) => {
    try {
      const file = String(req.params.file || '');
      if (!/^[\w.-]+\.mp4$/.test(file) || file.includes('..')) return res.status(400).json({ error: 'bad filename' });
      const adDir = ((readDirective().sniper || {}).adDir) || 'C:/Users/Drake/keystone-videos/out';
      const full = path.join(adDir, file);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'ad not rendered' });
      res.download(full, file);
    } catch (e) { log('sniper ad error:', e.message); res.status(500).json({ error: 'ad stream failed' }); }
  });

  log('sniper installed:', state.replies.length, 'reply(s) on record');
};
