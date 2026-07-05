'use strict';
/* panels.js — 07-04 batch: keystone pipeline, meme flow, ops chips, lydia bridge,
   ledger curve, push uplink, hold-to-restart action rail, milestone comet.
   Loads after app.js and reuses its globals ($, esc, getJson, scrambleTo, drawSpark,
   fmtCountdown, agoMin, agoFmt, shortAddr, money, lastFleet, directive, refreshOrrery, REDUCED). */

const FLOWQ_MS = 30000, KEYSTONE_MS = 60000, OPS_MS = 120000, LYDIA_MS = 120000, LEDGER_MS = 300000;
const HOLD_MS = 900;

window.flowqState = null;
window.keystoneState = null;
window.opsState = null;

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg, cls) {
  try {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${cls || ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  } catch (e) { console.error('toast', e); }
}

/* ---------- meme flow-quality ---------- */
async function loadFlowq() {
  try {
    const d = await getJson('/api/flowq');
    window.flowqState = d;
    const rows = (d.recent || []).map(r => `
      <div class="fq">
        <span class="tm">${esc(agoFmt(r.t))}</span>
        <span class="nm">${esc(shortAddr(r.mint))}</span>
        <span class="bd">${r.buyers}B · ${(+r.sol).toFixed(1)}◎ · T1 ${Math.round(r.top1 * 100)}%</span>
        <span class="mx">×${(+r.trigMult).toFixed(2)}</span>
      </div>`).join('');
    $('flowq').innerHTML = `
      <div class="wal-sum">${d.firesToday} FIRES TODAY · MED ${d.medBuyers ?? '—'} BUYERS · ${d.saturated} SAT</div>
      ${rows || '<div class="empty">no clean-2x fires yet today</div>'}
      <div class="nq-meta" style="margin-top:6px">LAST FRESH-LAUNCH TEST · OUTCOMES JOIN ~07-06</div>`;
    refreshOrrery();
  } catch (e) {
    console.error('flowq', e);
    $('flowq').innerHTML = '<div class="err">FLOW LINK DOWN — retrying</div>';
  }
}

/* ---------- keystone pipeline + reply sniper ---------- */
async function loadKeystone() {
  try {
    const [d, sn] = await Promise.all([
      getJson('/api/keystone'),
      getJson('/api/sniper').catch(() => null)
    ]);
    window.keystoneState = d;
    window.sniperState = sn;
    const rw = lastFleet.find(p => p.name === 'keystone-reply-watch');
    const rwOn = rw && rw.status === 'online';
    const pct = d.batchTotal ? Math.round(100 * d.batchSent / d.batchTotal) : 0;
    const recent = (d.recent || []).slice(0, 4).map(r => `
      <div class="ks-row">
        <span class="dot ${r.status === 'sent' ? 'dot-ok' : r.status === 'pending' ? 'dot-warn' : 'dot-off'}"></span>
        <span class="nm">${esc(r.name || '?')}</span>
        <span class="st">${esc((r.status || '').toUpperCase())}</span>
      </div>`).join('');
    $('keystone').innerHTML = `
      <div class="ks-ev"><span class="k">PIPELINE EV</span><span class="amt" id="ks-ev-amt"></span></div>
      <div class="ks-counts">${d.sent} SENT · ${d.pending} PENDING · ${d.rejected} REJ · $${d.evPerEmail}/EMAIL</div>
      <div class="ks-batch">
        <span class="k">BATCH 07-02</span>
        <div class="ks-bar"><div class="ks-fill" style="width:${pct}%"></div></div>
        <span class="v">${d.batchSent}/${d.batchTotal}</span>
      </div>
      ${d.batchSent < d.batchTotal ? `<div class="ks-due">${d.batchTotal - d.batchSent} REMAINING — REPLY BAIT READY IN out/</div>` : ''}
      ${(sn && sn.replies || []).slice(0, 3).map(r => `
        <div class="snipe ${r.category === 'INTERESTED' ? 'hot' : ''}">
          <div class="snipe-top">
            <span class="nm">${esc(r.name)}</span>
            <span class="cat">${esc(r.category)}</span>
            ${r.ad ? `<a class="ad-dl" href="/api/sniper/ad/${encodeURIComponent(r.ad)}" download>AD ⬇</a>` : ''}
          </div>
          ${r.subject ? `<div class="snipe-sub">${esc(r.subject.slice(0, 80))}</div>` : ''}
        </div>`).join('')}
      ${recent}
      <div class="nq-row" style="margin-top:4px">
        <span class="k">REPLY-WATCH</span>
        <span class="v ${rwOn ? '' : 'dn'}">${rwOn ? `LIVE · UID ${d.lastUid ?? '—'}` : 'DOWN'}</span>
      </div>`;
    scrambleTo($('ks-ev-amt'), '$' + (d.evUsd || 0).toLocaleString('en-US'), 600);
    refreshOrrery();
    buildTicker();
  } catch (e) {
    console.error('keystone', e);
    $('keystone').innerHTML = '<div class="err">KEYSTONE LINK DOWN — retrying</div>';
  }
}

/* ---------- ops chips: gold window + PALS + lead rails ---------- */
async function loadOps() {
  try {
    const [d, pals] = await Promise.all([
      getJson('/api/ops'),
      getJson('/api/pals').catch(() => null)
    ]);
    window.opsState = d;
    window.palsState = pals;
    renderOpsChips();
    refreshOrrery();
  } catch (e) { console.error('ops', e); }
}
function secondaryDeadline(re) {
  const s = ((directive || {}).secondary || []).find(x => re.test(x.label || ''));
  return s ? fmtCountdown(s.deadline) : null;
}
function renderOpsChips() {
  try {
    const el = $('ops-chips');
    if (!el || !window.opsState) return;
    const { journal, re } = window.opsState;
    const chips = [];
    const gold = secondaryDeadline(/GOLD/i);
    if (gold) chips.push(`<span class="chip ${gold.cls === 'past' ? 'stale' : 'high'}">XAU WINDOW <b>${gold.text}</b> · JRNL ${journal.gold}/${journal.gate}</span>`);
    const pals = secondaryDeadline(/PALS/i);
    const ps = window.palsState;
    const palsActive = ps && ps.status && /active/i.test(ps.status) && !/inactive/i.test(ps.status);
    if (palsActive) chips.push(`<span class="chip high">PALS <b>ACTIVE — GO</b> · ${esc(ps.license || '')}</span>`);
    else if (ps && ps.status) chips.push(`<span class="chip ${pals && pals.cls === 'past' ? 'stale' : ''}">PALS <b>${esc(ps.status.toUpperCase())}</b>${pals ? ` · VERIFY ${pals.text}` : ''} · HOURLY WATCH</span>`);
    else if (pals) chips.push(`<span class="chip ${pals.cls === 'past' ? 'stale' : ''}">PALS VERIFY <b>${pals.text}</b> · RS376134</span>`);
    if (re.probate != null) chips.push(`<span class="chip">PROBATE <b>${re.probate}</b> MAIL-ONLY</span>`);
    if (re.mailable != null) chips.push(`<span class="chip">TOP-200 <b>${re.mailable} READY</b></span>`);
    if (journal.open > 0) chips.push(`<span class="chip high">JOURNAL <b>${journal.open} OPEN</b></span>`);
    el.innerHTML = chips.join('');
    el.hidden = chips.length === 0;
  } catch (e) { console.error('opsChips', e); }
}
setInterval(renderOpsChips, 60000);

/* ---------- war room: boot-verify checklist ---------- */
let wrPhase = null, wrSkip = 0;
async function loadWarroom() {
  try {
    if (document.hidden) return;
    // outside the live window the checklist barely moves — poll 1-in-5 (5 min)
    if (wrPhase && wrPhase !== 'SESSION' && wrPhase !== 'BOOT WINDOW' && (wrSkip = (wrSkip + 1) % 5)) return;
    const d = await getJson('/api/warroom');
    wrPhase = d.phase;
    const dot = s => s === 'pass' ? 'dot-ok' : s === 'fail' ? 'dot-crit' : 'dot-warn';
    $('warroom').innerHTML = `
      <div class="wr-phase">${esc(d.phase)}${d.boot && d.boot.result ? ` · BOOT <b class="${d.boot.result === 'CLEAN' ? 'up' : 'dn'}">${esc(d.boot.result)}</b>` : ''}</div>
      ${(d.items || []).map(i => `
        <div class="nq-row">
          <span class="k"><span class="dot ${dot(i.state)}"></span> ${esc(i.label)}</span>
          <span class="v${i.state === 'fail' ? ' dn' : ''}">${esc(i.detail)}</span>
        </div>`).join('')}`;
  } catch (e) {
    console.error('warroom', e);
    $('warroom').innerHTML = '<div class="err">WAR ROOM LINK DOWN — retrying</div>';
  }
}

/* ---------- lydia bridge ---------- */
async function loadLydia() {
  try {
    const d = await getJson('/api/lydia');
    const p = lastFleet.find(f => f.name === 'lydia');
    const on = p && p.status === 'online';
    const snippet = (d.tail || '').split('\n').filter(l => l.trim() && !/^#/.test(l)).pop() || 'no voice notes yet';
    $('lydia').innerHTML = `
      <div class="nq-row">
        <span class="k"><span class="dot ${on ? 'dot-ok' : 'dot-crit'}"></span> CONSOLE</span>
        <span class="v">${on ? `ONLINE · R${p.restarts}` : 'DOWN'}</span>
      </div>
      <div class="nq-row">
        <span class="k">LAST VOICE NOTE</span>
        <span class="v">${d.noteAgeMin == null ? '—' : esc(agoMin(d.noteAgeMin))}</span>
      </div>
      <div class="lyd-note">${esc(snippet.slice(0, 220))}</div>`;
  } catch (e) {
    console.error('lydia', e);
    $('lydia').innerHTML = '<div class="err">LYDIA LINK DOWN — retrying</div>';
  }
}

/* ---------- ledger equity curve ---------- */
let ledgerData = null;
async function loadLedger() {
  try {
    const d = await getJson('/api/ledger');
    const cutoff = Date.now() - 30 * 86400000;
    const raw = (d.points || []).filter(p => p.bal > 1000 && p.t > cutoff); // 150K era, trailing 30d
    // sim rebuilds balance from a fixed base every session — no compounding curve exists,
    // so the honest view is per-day session PnL (realized at each day's close)
    const byDay = new Map();
    for (const p of raw) byDay.set(new Date(p.t).toISOString().slice(0, 10), p);
    ledgerData = [...byDay.entries()].map(([day, p]) => ({ day, pnl: p.real, bal: p.bal }));
    drawLedger(d.lastTs);
  } catch (e) {
    console.error('ledger', e);
    $('ledger-meta').textContent = 'LEDGER LINK DOWN';
  }
}
function drawLedger(lastTs) {
  try {
    const c = $('ledger-canvas');
    if (!c || !ledgerData) return;
    const days = ledgerData;
    const meta = $('ledger-meta');
    if (days.length < 2) { meta.textContent = 'NO SESSIONS YET'; return; }
    const d = devicePixelRatio || 1;
    const w = c.clientWidth * d, h = c.clientHeight * d;
    if (!w || !h) return;
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const maxAbs = Math.max(...days.map(p => Math.abs(p.pnl)), 1);
    const zero = h * 0.5;
    const bw = Math.max(2 * d, (w - 4) / days.length - 2 * d);
    g.strokeStyle = 'rgba(178,219,143,0.18)';
    g.lineWidth = d;
    g.beginPath(); g.moveTo(0, zero); g.lineTo(w, zero); g.stroke();
    days.forEach((p, i) => {
      const x = 2 + i / days.length * (w - 4);
      const bh = Math.abs(p.pnl) / maxAbs * (h * 0.44);
      if (p.pnl >= 0) {
        g.fillStyle = 'rgba(178,219,143,0.75)';
        g.fillRect(x, zero - bh, bw, Math.max(bh, d));
      } else {
        g.fillStyle = 'rgba(217,122,108,0.7)';
        g.fillRect(x, zero, bw, Math.max(bh, d));
      }
    });
    const last = days[days.length - 1];
    const sum = days.reduce((s, p) => s + p.pnl, 0);
    const ageH = lastTs ? Math.round((Date.now() - lastTs) / 3600000) : null;
    const f = v => `${v >= 0 ? '+' : '−'}${money(Math.abs(v))}`;
    meta.innerHTML = `LAST SESSION <span class="${last.pnl >= 0 ? 'up' : 'dn'}">${f(last.pnl)}</span>` +
      ` · 30D <span class="${sum >= 0 ? 'up' : 'dn'}">${f(sum)}</span> · BAL <b>${money(last.bal)}</b>` +
      (ageH != null && ageH > 26 ? ` · <span class="dn">STALE ${ageH}H</span>` : '');
  } catch (e) { console.error('drawLedger', e); }
}
addEventListener('resize', () => drawLedger(null));

/* ---------- push uplink ---------- */
const uplink = $('uplink');
function urlB64ToU8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}
function setUplink(txt, cls) {
  if (!uplink) return;
  uplink.textContent = txt;
  uplink.className = `uplink ${cls || ''}`;
}
// server-side subscriber total — the real "can any push land" signal, independent of this device.
async function serverSubs() {
  try { const j = await getJson('/api/push/pubkey'); return Number.isFinite(j.subs) ? j.subs : null; }
  catch { return null; }
}
async function uplinkStatus() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { setUplink('UPLINK N/A', 'na'); return 'na'; }
    if (Notification.permission === 'denied') { setUplink('UPLINK DENIED', 'na'); return 'denied'; }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    const n = await serverSubs();
    // 0 subscribers = the whole push layer is dark; make it loud regardless of this device's state.
    if (n === 0) { setUplink(sub ? 'UPLINK LINKED ·0' : 'UPLINK 0 — DARK', 'dark'); return sub ? 'linked' : 'off'; }
    const tag = n == null ? '' : ` ·${n}`;
    if (sub) { setUplink(`UPLINK LINKED${tag}`, 'on'); return 'linked'; }
    setUplink(`UPLINK OFF${tag}`, ''); return 'off';
  } catch (e) { console.error('uplinkStatus', e); setUplink('UPLINK ERR', 'na'); return 'err'; }
}
async function uplinkConnect() {
  try {
    const iosBrowserTab = /iP(hone|ad|od)/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches;
    if (iosBrowserTab) { toast('iOS: ADD TO HOME SCREEN FIRST, THEN LINK', 'warn'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { await uplinkStatus(); return; }
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const { key } = await getJson('/api/push/pubkey');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(key) });
    const r = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub)
    });
    if (!r.ok) throw new Error('subscribe ' + r.status);
    const { subs } = await r.json().catch(() => ({}));
    setUplink(`UPLINK LINKED${Number.isFinite(subs) ? ` ·${subs}` : ''}`, 'on');
    toast('UPLINK LIVE — the room can reach you now', 'ok');
  } catch (e) {
    console.error('uplinkConnect', e);
    toast('UPLINK FAILED — ' + e.message, 'err');
    await uplinkStatus();
  }
}
if (uplink) uplink.addEventListener('click', async () => {
  const st = await uplinkStatus();
  if (st === 'off') return uplinkConnect();
  if (st === 'linked') {
    const pin = localStorage.getItem('sovPin');
    if (!pin) { toast('TEST PUSH NEEDS PIN — restart something once first', 'warn'); return; }
    try {
      const r = await fetch('/api/push/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin }) });
      toast(r.ok ? 'TEST PUSH SENT' : 'TEST PUSH REFUSED', r.ok ? 'ok' : 'err');
    } catch (e) { toast('TEST PUSH FAILED', 'err'); }
  }
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.error('sw', e));
uplinkStatus();
// refresh the server count while the tab is visible (backoff when hidden, per client-poll convention).
setInterval(() => { if (document.visibilityState === 'visible') uplinkStatus(); }, 30000);

/* ---------- action rail: hold a fleet row to restart ---------- */
const holdRing = $('hold-ring');
let hold = null;
function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.timer);
  if (holdRing) { holdRing.hidden = true; holdRing.classList.remove('arm'); }
  hold = null;
}
function allowedActions() {
  return (directive && directive.action && Array.isArray(directive.action.allow)) ? directive.action.allow : [];
}
const fleetEl = $('fleet');
if (fleetEl) {
  fleetEl.addEventListener('contextmenu', e => e.preventDefault());
  fleetEl.addEventListener('pointerdown', e => {
    const row = e.target.closest('.proc');
    if (!row) return;
    const name = (row.querySelector('.nm') || {}).textContent;
    if (!name || !allowedActions().includes(name)) return;
    hold = { name, x: e.clientX, y: e.clientY, row };
    if (holdRing) {
      holdRing.style.left = `${e.clientX - 21}px`;
      holdRing.style.top = `${e.clientY - 21}px`;
      holdRing.hidden = false;
      requestAnimationFrame(() => holdRing.classList.add('arm'));
    }
    hold.timer = setTimeout(() => {
      const armed = hold; cancelHold();
      if (navigator.vibrate) navigator.vibrate(35);
      openPinModal(armed.name, armed.row);
    }, HOLD_MS);
  });
  fleetEl.addEventListener('pointermove', e => {
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) cancelHold();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => fleetEl.addEventListener(ev, cancelHold));
}

let pinTarget = null;
function openPinModal(name, row) {
  pinTarget = { name, row };
  $('pin-title').textContent = `RESTART ${name.toUpperCase()}`;
  $('pin-sub').textContent = 'pm2 restart — allowlisted action';
  $('pin-err').textContent = '';
  $('pin-input').value = localStorage.getItem('sovPin') || '';
  $('pin-modal').hidden = false;
  setTimeout(() => $('pin-input').focus(), 50);
}
function closePinModal() { $('pin-modal').hidden = true; pinTarget = null; }
$('pin-cancel').addEventListener('click', closePinModal);
$('pin-modal').addEventListener('click', e => { if (e.target === $('pin-modal')) closePinModal(); });
$('pin-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('pin-go').click(); });
$('pin-go').addEventListener('click', async () => {
  if (!pinTarget) return;
  const pin = $('pin-input').value.trim();
  if (!pin) { $('pin-err').textContent = 'PIN REQUIRED'; return; }
  $('pin-go').disabled = true;
  try {
    const r = await fetch('/api/action/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: pinTarget.name, pin })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { $('pin-err').textContent = (body.error || `HTTP ${r.status}`).toUpperCase(); return; }
    localStorage.setItem('sovPin', pin);
    const nm = pinTarget.row && pinTarget.row.querySelector('.nm');
    if (nm) scrambleTo(nm, pinTarget.name, 900);
    toast(`${pinTarget.name.toUpperCase()} RESTARTED`, 'ok');
    closePinModal();
  } catch (e) {
    $('pin-err').textContent = 'LINK FAILED';
  } finally {
    $('pin-go').disabled = false;
  }
});

/* ---------- milestone comet (directive.celebrate) ---------- */
let fxActive = false;
function runCelebrate(text) {
  if (fxActive) return;
  fxActive = true;
  window.__fxBusy = true; // tape streaks yield fx-canvas while the comet flies
  try {
    const banner = $('celebrate-banner');
    banner.hidden = false;
    scrambleTo(banner, `MILESTONE — ${text}`, 900);
    setTimeout(() => { banner.hidden = true; }, 9000);
    if (REDUCED) { fxActive = false; window.__fxBusy = false; return; }
    const c = $('fx-canvas');
    const d = devicePixelRatio || 1;
    c.width = innerWidth * d; c.height = innerHeight * d;
    const g = c.getContext('2d');
    const t0 = performance.now(), DUR = 4200;
    const trail = [];
    (function fx(t) {
      const p = (t - t0) / DUR;
      if (p >= 1) { g.clearRect(0, 0, c.width, c.height); fxActive = false; window.__fxBusy = false; return; }
      const x = (-0.1 + p * 1.25) * c.width;
      const y = c.height * (0.22 + 0.34 * Math.sin(p * Math.PI * 0.9)) + Math.sin(p * 20) * 6 * d;
      trail.push({ x, y, at: t });
      g.clearRect(0, 0, c.width, c.height);
      for (const s of trail) {
        const age = (t - s.at) / 900;
        if (age > 1) continue;
        g.fillStyle = `rgba(240,209,148,${0.55 * (1 - age)})`;
        g.beginPath(); g.arc(s.x - age * 90 * d, s.y + age * 14 * d, (1 - age) * 3.2 * d, 0, Math.PI * 2); g.fill();
      }
      const glow = g.createRadialGradient(x, y, 0, x, y, 26 * d);
      glow.addColorStop(0, 'rgba(255,244,214,0.95)');
      glow.addColorStop(0.3, 'rgba(240,209,148,0.5)');
      glow.addColorStop(1, 'rgba(240,209,148,0)');
      g.fillStyle = glow;
      g.beginPath(); g.arc(x, y, 26 * d, 0, Math.PI * 2); g.fill();
      requestAnimationFrame(fx);
    })(t0);
  } catch (e) { console.error('celebrate', e); fxActive = false; window.__fxBusy = false; }
}
setInterval(() => {
  try {
    const c = directive && directive.celebrate;
    if (c && localStorage.getItem('sovCelebrated') !== c) {
      localStorage.setItem('sovCelebrated', c);
      runCelebrate(c);
    }
  } catch (e) { console.error('celebrateCheck', e); }
}, 20000);

/* ---------- boot ---------- */
loadFlowq(); setInterval(loadFlowq, FLOWQ_MS);
loadKeystone(); setInterval(loadKeystone, KEYSTONE_MS);
loadWarroom(); setInterval(loadWarroom, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadWarroom(); });
loadOps(); setInterval(loadOps, OPS_MS);
loadLydia(); setInterval(loadLydia, LYDIA_MS);
setTimeout(loadLedger, 800); setInterval(loadLedger, LEDGER_MS);
