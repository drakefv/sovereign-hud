// util.js — canonical tiny helpers. One copy of the file-freshness, ET-clock,
// and JSON-persistence primitives that every server module leans on. If you
// need one of these in a new module, require it from here — do not re-roll it.
'use strict';

const fs = require('fs');
const path = require('path');

// mtime+size gate: skip re-parsing a source file that hasn't changed since last look
const fileSig = p => { try { const s = fs.statSync(p); return s.mtimeMs + ':' + s.size; } catch { return 'missing'; } };

const fileAgeMin = p => { try { return Math.round((Date.now() - fs.statSync(p).mtimeMs) / 60000); } catch { return null; } };

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const writeJson = (p, obj, pretty) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
};

// ET wall clock — all market-gate math runs in ET, one implementation
function etParts() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false }));
  return {
    weekday: d.getDay() >= 1 && d.getDay() <= 5,
    hour: d.getHours(),
    minutes: d.getHours() * 60 + d.getMinutes(),
    dateStr: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  };
}
const etToday = () => etParts().dateStr;

module.exports = { fileSig, fileAgeMin, readJson, writeJson, etParts, etToday };
