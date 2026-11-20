/**
 * Referral Step 2, member side (owner 2026-11-20; GATE_REFERRAL_STEP2, off): the pure rules. No database, no gate
 * read; referral-engine.js reads the gate and does the money moves with these answers.
 *
 *   amount   the member's credit: a flat standard amount (step2_referrer_reward_cents, $25), $0 at the yearly limit
 *   year     the member's credit cap counts a calendar year in America/New_York
 * (Owner 2026-11-20, "C": no half-mile bonus. The two near columns the first migration added stay in the table and
 * nothing reads, writes or shows them.)
 */
const { parseETDateTime, etParts } = require('../utils/datetime-et');

// The owner's numbers, also the values the migration puts on the settings row. A settings row read before that
// migration ran has none of the columns, so each falls back here.
const STEP2_DEFAULTS = Object.freeze({
  step2_referrer_reward_cents: 2500,
  step2_annual_credit_cap: 10,
});

// A column holds a number or null (an admin can clear a field); null and a non-number fall back to the default.
function step2Settings(settings = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(STEP2_DEFAULTS)) {
    const raw = settings[key];
    const n = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    out[key] = Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  return out;
}

// The member's credit in cents and why: always 'standard' (the cap is applied by the caller).
function memberCredit(settings) {
  return { cents: step2Settings(settings).step2_referrer_reward_cents, reason: 'standard' };
}

// [start, end) of the America/New_York calendar year holding `now`, as instants.
function etYearBounds(now = new Date()) {
  const { year } = etParts(now);
  return {
    start: parseETDateTime(`${year}-01-01T00:00`),
    end: parseETDateTime(`${year + 1}-01-01T00:00`),
  };
}

// True when the member has already earned the year's cap, so the next credit is not posted.
function capReached(creditsThisYear, settings) {
  return Number(creditsThisYear) >= step2Settings(settings).step2_annual_credit_cap;
}

// Cents-accurate: $25, $25.50 (never $26 or $25.5).
const formatDollars = (dollarAmount) => {
  const n = Number(dollarAmount) || 0;
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
};
const dollars = (cents) => formatDollars(Number(cents) / 100);
// The rule as staff read it before confirming a referral, from the EFFECTIVE settings (the live row, never literals)
// and whether the member is already at the yearly limit (then the member gets $0, and no member thank-you email
// follows because the email goes out for a posted credit). `text` for the full line, `short` for a button prompt.
function ruleTerms(settings, atCap = false) {
  const s = step2Settings(settings);
  const friend = dollars(Number(settings?.referee_discount_cents) || 0);
  const std = dollars(s.step2_referrer_reward_cents);
  // `conditional`: for a member whose standing is not known (staff picked someone other than the suggested member).
  const conditional = `Member: ${std}, unless at the yearly limit; friend: ${friend} credit`;
  if (atCap) {
    return { atCap: true, text: `Member is at the yearly limit: $0; friend: ${friend} credit`, short: `member at the yearly limit: $0; friend ${friend}`, conditional };
  }
  return { atCap: false, text: `Member: ${std}; friend: ${friend} credit`, short: `member ${std}; friend ${friend}`, conditional };
}

module.exports = { STEP2_DEFAULTS, step2Settings, memberCredit, etYearBounds, capReached, ruleTerms, formatDollars };
