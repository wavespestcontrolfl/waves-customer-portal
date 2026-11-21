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


// The friend's words, gate on (owner 2026-11-21, "visit" + "flat"): every referred friend gets an account credit after
// the first plan service, no deadline, the amount the Referee Discount setting holds. Each line takes cents and the
// caller decides the gate and reads the settings; every Step 2 customer line lives here.

// The invitation email's offer line (referral.friend_invite).
// It keeps the instruction to book through the link: a friend who books another way is not tied to the member.
const friendInviteOfferLine = (refereeCents) => `Start a Waves plan through their referral link and get a ${dollars(refereeCents)} credit on your Waves account after your first service. Our way of saying welcome.`;

// The share text's clause, inside "We use Waves and ..." (SMS) and "We use Waves Pest Control and ..." (email).
const friendShareClause = (refereeCents, code) => `they'll give you a ${dollars(refereeCents)} credit after your first plan service with my code ${code}`;

// The friend's part of the member invitation email's reward line (referral.invite), after "you get a $25 referral reward and ".
const memberInviteFriendClause = (refereeCents) => `they get a ${dollars(refereeCents)} credit after their first plan service`;

// The member's credit email, account-credit destination (the same line with the gate on or off). Account credit is used
// on an invoice only after the customer turns the switch on, so the line says how. The caller passes true only for a
// member who can see that switch and has it off (active account, credit balance above 0, switch off): any other reader
// gets the credit sentence alone, never an instruction they cannot follow or do not need.
const memberCreditEmailLine = (rewardDollars, { canTurnOnAutomaticCredit = false } = {}) => `Your ${formatDollars(rewardDollars)} referral reward has been added to your Waves account as a credit.${
  canTurnOnAutomaticCredit ? ' To use it on your next invoice, turn on "Apply my credit to invoices automatically" in the Waves app.' : ''}`;

module.exports = {
  STEP2_DEFAULTS, step2Settings, memberCredit, etYearBounds, capReached, ruleTerms, formatDollars,
  friendInviteOfferLine, friendShareClause, memberInviteFriendClause, memberCreditEmailLine,
};
