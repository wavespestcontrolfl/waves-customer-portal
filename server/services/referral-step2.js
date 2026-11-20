/**
 * Referral Step 2, member side (owner 2026-11-20; GATE_REFERRAL_STEP2, off): the pure rules. No database, no gate
 * read; referral-engine.js reads the gate and does the money moves with these answers.
 *
 *   amount   the member's credit: the near amount when both homes have a map point and the straight-line distance
 *            is within step2_near_radius_miles, else the standard amount
 *   year     the member's credit cap counts a calendar year in America/New_York
 */
const { haversine } = require('./route-optimizer');
// The one rule for "this home has a map point" (customer-geocode review): a missing, non-numeric or ZERO latitude or
// longitude is no pin, so two placeholder (0, 0) homes are never "zero miles apart".
const { hasPin } = require('./customer-geocode-review');
const { parseETDateTime, etParts } = require('../utils/datetime-et');

// The owner's numbers, also the values the migration puts on the settings row. A settings row read before that
// migration ran has none of the columns, so each falls back here.
const STEP2_DEFAULTS = Object.freeze({
  step2_referrer_reward_cents: 2500,
  step2_near_referrer_reward_cents: 5000,
  step2_near_radius_miles: 0.5,
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

// The member's credit in cents and why: 'near' or 'standard'. A home without a map point is never near.
function memberCredit(memberHome, friendHome, settings) {
  const s = step2Settings(settings);
  if (memberHome && friendHome && hasPin(memberHome) && hasPin(friendHome)) {
    const miles = haversine(
      Number(memberHome.latitude), Number(memberHome.longitude),
      Number(friendHome.latitude), Number(friendHome.longitude),
    );
    if (miles <= s.step2_near_radius_miles) return { cents: s.step2_near_referrer_reward_cents, reason: 'near' };
  }
  return { cents: s.step2_referrer_reward_cents, reason: 'standard' };
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

const dollars = (cents) => `$${Number((Number(cents) / 100).toFixed(2))}`;
const miles = (n) => (n === 0.5 ? 'half a mile' : `${n} ${n === 1 ? 'mile' : 'miles'}`);

// The rule as staff read it before confirming a referral, from the EFFECTIVE settings (the live row, never literals)
// and whether the member is already at the yearly limit (then the member gets $0, and no member thank-you email
// follows because the email goes out for a posted credit). `text` for the full line, `short` for a button prompt.
function ruleTerms(settings, atCap = false) {
  const s = step2Settings(settings);
  const friend = dollars(Number(settings?.referee_discount_cents) || 0);
  if (atCap) {
    return { atCap: true, text: `Member is at the yearly limit: $0; friend: ${friend} credit`, short: `member at the yearly limit: $0; friend ${friend}` };
  }
  const std = dollars(s.step2_referrer_reward_cents);
  const near = dollars(s.step2_near_referrer_reward_cents);
  const within = miles(s.step2_near_radius_miles);
  return { atCap: false, text: `Member: ${std}, or ${near} within ${within}; friend: ${friend} credit`, short: `member ${std} or ${near} within ${within}; friend ${friend}` };
}

module.exports = { STEP2_DEFAULTS, step2Settings, memberCredit, etYearBounds, capReached, ruleTerms };
