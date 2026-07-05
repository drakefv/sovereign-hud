// verdict.js — THE single NQ-verdict evaluator. The rule used to live in three
// places (app.js, tape.js, and the bot itself); this file is now the HUD's only
// copy. Server attaches it to /api/nq, tape/warroom/digest consume it, and the
// frontend prefers the served verdict over its local fallback.
'use strict';

// d = the /api/nq payload shape: { bias, guards, account }
function nqVerdict(d) {
  const g = (d && d.guards) || {};
  const acct = d && d.account;
  const locked = g.portfolioKill || g.circuitTripped ||
    (acct && acct.lockState && acct.lockState !== 'open');
  if (locked) return { text: 'LOCKED', cls: 'locked' };
  const bias = d && d.bias;
  if (!bias || bias.composite == null) return { text: 'NO BIAS', cls: 'skip' };
  const c = +bias.composite;
  const skipTh = bias.skipThreshold != null ? +bias.skipThreshold : -0.5;
  const upTh = bias.upsizeThreshold != null ? +bias.upsizeThreshold : 0.2;
  if (c <= skipTh) return { text: 'SKIP DAY', cls: 'skip' };
  if (c >= upTh) return { text: 'UPSIZE', cls: 'upsize' };
  return { text: 'CLEAR', cls: 'clear' };
}

// adapter for readers of nq-bot's raw phase_s_daily.json (snake_case) —
// tape and warroom both consume the file directly, one mapping lives here.
// account is optional: pass it to fold account lock into the LOCKED verdict.
nqVerdict.fromBiasFile = (bias, guards, account) => nqVerdict({
  bias: bias && {
    composite: bias.composite,
    skipThreshold: bias.skip_threshold,
    upsizeThreshold: bias.upsize_threshold
  },
  guards,
  account
});

module.exports = nqVerdict;
