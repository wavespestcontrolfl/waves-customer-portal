/**
 * Referral Step 2, member side (owner 2026-11-20; GATE_REFERRAL_STEP2, off): the pure rules. No database, no gate
 * read; referral-engine.js reads the gate and does the money moves with these answers.
 *
 *   amount   the member's credit: the near amount when both homes have a map point and the straight-line distance
 *            is within step2_near_radius_miles, else the standard amount
 *   year     the member's credit cap counts a calendar year in America/New_York
 *   settled  the member is paid after the friend's first plan visit is paid
 */
const { haversine } = require('./route-optimizer');
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

function hasPoint(home) {
  if (!home || home.latitude == null || home.longitude == null) return false;
  return Number.isFinite(Number(home.latitude)) && Number.isFinite(Number(home.longitude));
}

// The member's credit in cents and why: 'near' or 'standard'. A home without a map point is never near.
function memberCredit(memberHome, friendHome, settings) {
  const s = step2Settings(settings);
  if (hasPoint(memberHome) && hasPoint(friendHome)) {
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

// Whether the friend's first plan visit is settled. `invoices`: every invoice that bills the visit. With a live (not
// void or cancelled) invoice, every one must be paid or prepaid (covered in full). With none, the visit counts only
// when it is provably covered without an invoice of its own (`covered`: a prepaid stamp, or dues collected for a
// monthly member): an unbilled visit that nothing covers has not been paid for.
const DEAD_INVOICE_STATUSES = ['void', 'voided', 'cancelled', 'canceled'];
const SETTLED_INVOICE_STATUSES = ['paid', 'prepaid'];
function visitSettled(invoices = [], covered = false) {
  const live = invoices.filter((i) => !DEAD_INVOICE_STATUSES.includes(String(i.status || '').toLowerCase()));
  if (!live.length) return covered === true;
  return live.every((i) => SETTLED_INVOICE_STATUSES.includes(String(i.status || '').toLowerCase()));
}

module.exports = { STEP2_DEFAULTS, step2Settings, memberCredit, etYearBounds, capReached, visitSettled };
