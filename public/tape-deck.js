'use strict';
/* tape-deck.js — 07-05 batch: THE TAPE (merged empire feed) + phone deck navigation.
   Loads after app.js/panels.js and reuses their globals ($, esc, getJson, agoFmt, REDUCED, toast). */

const TAPE_MS = 15000;

window.tapeState = null;

/* ---------- THE TAPE ---------- */
const KIND_GLYPH = { fleet: '▣', flow: '◈', keystone: '◆', nq: '▲', lydia: '●', econ: '◔', sys: '○', re: '⌂', war: '⚑' };
let tapeNewest = 0, tapeRendered = false, tapeLastRender = 0;

async function loadTape() {
  try {
    const d = await getJson('/api/tape');
    window.tapeState = d;
    const evs = (d.events || []).slice(0, 40);
    const newest = evs.length ? evs[0].t : 0;
    // nothing new — skip the reflow, but still refresh ago-labels every 5 min
    if (tapeRendered && newest <= tapeNewest && Date.now() - tapeLastRender < 300000) return;
    tapeLastRender = Date.now();
    const isFresh = e => tapeRendered && e.t > tapeNewest;
    $('tape').innerHTML = evs.length === 0
      ? '<div class="empty">tape is silent — events land here as the empire moves</div>'
      : evs.map(e => `
        <div class="tp ${esc(e.cls)}${isFresh(e) ? ' fresh' : ''}">
          <span class="tp-tm">${esc(agoFmt(new Date(e.t).toISOString()))}</span>
          <span class="tp-gl">${KIND_GLYPH[e.kind] || '·'}</span>
          <span class="tp-msg">${esc(e.msg)}</span>
        </div>`).join('');
    const fresh = evs.filter(isFresh);
    if (fresh.length) {
      for (const e of fresh.slice(0, 3)) spawnStreak(e.cls);
      if (fresh.some(e => e.cls === 'crit') && navigator.vibrate) navigator.vibrate([30, 60, 30]);
      const badge = $('deck-badge-ops');
      if (badge && deckIndex() !== 2) badge.hidden = false;
    }
    tapeNewest = Math.max(tapeNewest, newest);
    tapeRendered = true;
  } catch (e) {
    console.error('tape', e);
    $('tape').innerHTML = '<div class="err">TAPE LINK DOWN — retrying</div>';
  }
}

/* ---------- event streaks: small comets across the room per tape event ---------- */
const STREAK_RGB = { ok: '178,219,143', hot: '211,245,176', warn: '219,179,95', crit: '217,122,108', flow: '159,212,212', info: '121,133,111' };
let streaks = [], streakRaf = null;
function spawnStreak(cls) {
  try {
    if (REDUCED || window.__fxBusy) return; // celebrate comet owns fx-canvas while it runs
    streaks.push({
      born: performance.now(),
      y: 0.06 + Math.random() * 0.22,
      dir: Math.random() < 0.5 ? 1 : -1,
      rgb: STREAK_RGB[cls] || STREAK_RGB.info,
      dur: 900 + Math.random() * 500
    });
    if (!streakRaf) streakRaf = requestAnimationFrame(drawStreaks);
  } catch (e) { console.error('spawnStreak', e); }
}
function drawStreaks(t) {
  try {
    if (window.__fxBusy) { streaks = []; streakRaf = null; return; }
    const c = $('fx-canvas');
    const d = devicePixelRatio || 1;
    if (c.width !== innerWidth * d) { c.width = innerWidth * d; c.height = innerHeight * d; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    streaks = streaks.filter(s => t - s.born < s.dur);
    for (const s of streaks) {
      const p = (t - s.born) / s.dur;
      const head = s.dir > 0 ? p * 1.15 - 0.05 : 1.05 - p * 1.15;
      const y = s.y * c.height;
      for (let i = 0; i < 9; i++) {
        const trail = head - s.dir * i * 0.012;
        const a = (1 - p) * (1 - i / 9) * 0.7;
        if (a <= 0) continue;
        g.fillStyle = `rgba(${s.rgb},${a})`;
        const r = (2.4 - i * 0.2) * d;
        g.fillRect(trail * c.width - r / 2, y - r / 2 + i * 0.6 * d, r, r);
      }
    }
    if (streaks.length) { streakRaf = requestAnimationFrame(drawStreaks); }
    else { streakRaf = null; g.clearRect(0, 0, c.width, c.height); }
  } catch (e) { console.error('drawStreaks', e); streakRaf = null; }
}

/* ---------- launchpad: link groups from directive.json (live config) ---------- */
let lpRendered = '';
function renderLaunchpad() {
  try {
    const el = $('launchpad');
    const pad = directive && directive.launchpad;
    if (!el || !Array.isArray(pad)) return;
    const sig = JSON.stringify(pad);
    if (sig === lpRendered) return;
    lpRendered = sig;
    el.innerHTML = pad.map(g => `
      <div class="lp-h">${esc(g.group || '')}</div>
      <div class="lp-grid">
        ${(g.links || []).map(l => `
          <a class="lp-link${l.hot ? ' hot' : ''}" href="${esc(l.url || '#')}" target="_blank" rel="noopener">
            <span class="lp-lbl">${esc(l.label || '?')}</span>
            ${l.sub ? `<span class="lp-sub">${esc(l.sub)}</span>` : ''}
          </a>`).join('')}
      </div>`).join('');
  } catch (e) { console.error('launchpad', e); }
}
setInterval(renderLaunchpad, 2000);
renderLaunchpad();

/* ---------- phone deck navigation: DESK / CORE / OPS ---------- */
const cockpit = document.querySelector('.cockpit');
const deckbar = $('deckbar');
// deck mode is derived from the CSS itself (deckbar only displays inside the
// mobile media query) so JS can never disagree with the stylesheet breakpoint
const deckMode = () => !!deckbar && getComputedStyle(deckbar).display !== 'none';
function deckIndex() {
  if (!cockpit || !cockpit.clientWidth) return 1;
  return Math.round(cockpit.scrollLeft / cockpit.clientWidth);
}
function setActiveDeck(i) {
  try {
    if (!deckbar) return;
    deckbar.querySelectorAll('.deck-btn').forEach(b => b.classList.toggle('active', +b.dataset.deck === i));
    if (i === 2) { const badge = $('deck-badge-ops'); if (badge) badge.hidden = true; }
  } catch (e) { console.error('setActiveDeck', e); }
}
function gotoDeck(i, smooth) {
  try {
    if (!cockpit) return;
    cockpit.scrollTo({ left: i * cockpit.clientWidth, behavior: smooth === false || REDUCED ? 'auto' : 'smooth' });
    setActiveDeck(i);
  } catch (e) { console.error('gotoDeck', e); }
}
if (deckbar) {
  deckbar.querySelectorAll('.deck-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (navigator.vibrate) navigator.vibrate(8);
      gotoDeck(+b.dataset.deck);
    });
    // OPS gets an unread-tape badge dot
    if (+b.dataset.deck === 2) {
      const dot = document.createElement('span');
      dot.id = 'deck-badge-ops';
      dot.className = 'deck-badge';
      dot.hidden = true;
      b.appendChild(dot);
    }
  });
}
if (cockpit) {
  let scrollTmr = null;
  cockpit.addEventListener('scroll', () => {
    if (!deckMode()) return;
    clearTimeout(scrollTmr);
    scrollTmr = setTimeout(() => setActiveDeck(deckIndex()), 90);
  }, { passive: true });
}
let wasDeckMode = false;
function deckBoot() {
  try {
    if (!deckMode() || !cockpit) return;
    // land on CORE, instantly, once layout exists
    requestAnimationFrame(() => gotoDeck(1, false));
  } catch (e) { console.error('deckBoot', e); }
}
addEventListener('resize', () => {
  const m = deckMode();
  if (m && !wasDeckMode) deckBoot();
  else if (m) gotoDeck(deckIndex(), false);
  wasDeckMode = m;
});
wasDeckMode = deckMode();
deckBoot();

/* ---------- boot ---------- */
loadTape(); setInterval(loadTape, TAPE_MS);
