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
const { stripSmsUrlScheme } = require('./messaging/sms-link-policy');

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

// The share card's offer line (service report + accepted-estimate screens), gate on: "They get a $50 credit after their
// first plan service. You get $25." Each sentence stands alone and drops when its amount is 0; the member sentence also
// drops at the yearly limit (never promise a credit that will not post). '' when neither is left: the card keeps its
// static words. The caller reads the live amounts and the limit (referralOfferDecision).
const shareCardOffer = ({ refereeCents, memberCents, atLimit = false }) => [
  Number(refereeCents) > 0 ? `They get a ${dollars(refereeCents)} credit after their first plan service.` : '',
  !atLimit && Number(memberCents) > 0 ? `You get ${dollars(memberCents)}.` : '',
].filter(Boolean).join(' ');

// The member's credit email, account-credit destination (the same line with the gate on or off). Account credit is used
// only after the customer turns the switch on, so the line says how. It names no invoice: even with the switch on, an
// invoice another payer is billed for or one on a payment plan takes no credit. The caller passes true only for a
// member who can see that switch and has it off (active account, credit balance above 0, switch off): any other reader
// gets the credit sentence alone, never an instruction they cannot follow or do not need.
const memberCreditEmailLine = (rewardDollars, { canTurnOnAutomaticCredit = false } = {}) => `Your ${formatDollars(rewardDollars)} referral reward has been added to your Waves account as a credit.${
  canTurnOnAutomaticCredit ? ' To use it, turn on "Apply my credit to invoices automatically" in the Waves app.' : ''}`;

// The stored texts (words: owner 2026-11-21). The texts in the database stay as they are; with the gate on, the SEEDED
// sentence inside a rendered text is swapped for the approved Step 2 words, so nothing is edited by hand on flip day and
// the amounts are always the live setting. A text an admin rewrote no longer holds the seeded sentence and is returned
// as stored. Every swap takes the amounts in cents from the caller and states a credit only when it is above 0: with
// the gate on a seeded reward sentence is never sent as stored. Swaps use string slicing, never a replacement
// string, because the words hold "$".

// The referral invite text submitReferral sends (the Referral Settings column, or the referral_invite row when the
// column is empty). submitReferral refuses a phone that is already a Waves customer; POST /referrals/invite does not
// check the recipient, so that route sends the row as stored and promises no credit.
// head = the words before the offer; legacy = the seeded offer. The seeded text ends "<stretch><the referral link>"
// with an optional STOP line. The match needs that exact link, so a name that happens to hold the stretch does not
// match, and neither does a text an admin pointed at something else (a phone number in place of the link).
const SEEDED_INVITE_OFFERS = Object.freeze([
  { head: ' recommended Waves. ', legacy: "You'll both save when you sign up" },
  { head: ' recommended Waves to you. ', legacy: 'Get a free quote' },
]);
const INVITE_STOP_LINE = '\n\nReply STOP to opt out.';
const friendInviteSmsOffer = (refereeCents) => `Start a plan and get a ${dollars(refereeCents)} credit after your first plan service`;
// With the gate on and no friend credit to state (a $0 setting, the program paused, the settings unreadable), a seeded
// invite promises nothing: the referral_invite row's own words, which name no reward.
const NEUTRAL_INVITE_OFFER = 'Get a free quote';

// `body` is the RENDERED text (names and link filled in); `link` is the referral link the caller rendered it with.
// The settings column is filled with the link as given; the saved-text renderer shows it without https://
// (stripSmsUrlScheme), so both forms match. step2On false (the gate is off), or no link to match: exactly as rendered.
function inviteSmsWithOffer(body, { step2On = false, refereeCents = 0, link = '' } = {}) {
  const text = String(body ?? '');
  if (!step2On || !link) return text;
  const offer = Number(refereeCents) > 0 ? friendInviteSmsOffer(refereeCents) : NEUTRAL_INVITE_OFFER;
  const tails = [...new Set([link, stripSmsUrlScheme(link)])].flatMap((shown) => [shown, `${shown}${INVITE_STOP_LINE}`]);
  for (const { head, legacy } of SEEDED_INVITE_OFFERS) {
    for (const tail of tails) {
      const seeded = `${head}${legacy}: ${tail}`;
      if (text.endsWith(seeded)) return `${text.slice(0, text.length - seeded.length)}${head}${offer}: ${tail}`;
    }
  }
  return text;
}

// The office composer's referral insert (buildReferralLink). Today's line while there is no new amount.
const composerReferralLine = (link, refereeCents) => (Number(refereeCents) > 0
  ? `Know someone who needs pest or lawn care? They get a ${dollars(refereeCents)} credit after their first plan service with your link: ${link}\n\n`
  : `Know someone who needs pest control? Share Waves here: ${link}\n\n`);

// The referral_nudge email (Automations tab). The seeded sentence differs in the two bodies: the HTML body has it as a
// sentence of its own, the text body after a dash.
const NUDGE_SEEDED = Object.freeze({
  html: 'When a neighbor, friend, or family member signs up for a recurring plan with it and we complete their first service, you each get a <strong>$25 account credit</strong>.',
  text: ' — when a neighbor signs up for a recurring plan with it and we complete their first service, you each get a $25 account credit.',
  preview: 'Refer a neighbor: you each get a $25 account credit.',
});

// The credits a nudge may state, in cents: each one only when it is paid. The member's is 0 at the yearly limit, so a
// member at the limit is never promised a credit. The email body and the preview summary both read this.
const nudgeCredits = ({ refereeCents, memberCents, atLimit = false }) => ({
  friend: Math.max(0, Number(refereeCents) || 0),
  member: atLimit ? 0 : Math.max(0, Number(memberCents) || 0),
});

// The approved sentences: the friend's credit, then the member's. One of them at $0: the other alone (the member's
// alone is today's sentence without "each"). Neither: no sentence, so nothing is promised.
const nudgeEmailOffer = (offer, html) => {
  const { friend, member } = nudgeCredits(offer);
  const credit = (cents) => (html ? `<strong>${dollars(cents)} account credit</strong>` : `${dollars(cents)} account credit`);
  const start = 'When a neighbor, friend or family member starts a recurring plan with your link';
  if (!friend) return member ? `${start} and we complete their first service, you get a ${credit(member)}.` : '';
  return `${start}, they get a ${credit(friend)} after their first service.${member ? ` After we complete their first service, you get a ${credit(member)}.` : ''}`;
};

// `body` is the stored step body (html or text); `offer` = { refereeCents, memberCents, atLimit } from a decision made
// with the gate on. A body without the seeded sentence is returned as stored. EVERY occurrence is swapped (a body
// with the seeded paragraph pasted twice must not keep one copy of the old promise); split/join, never a replacement
// string, because the words hold "$".
function nudgeEmailWithOffer(body, { html = false, ...offer }) {
  const text = String(body ?? '');
  const seeded = html ? NUDGE_SEEDED.html : NUDGE_SEEDED.text;
  if (!text.includes(seeded)) return text;
  const words = nudgeEmailOffer(offer, html);
  // The text body's seeded stretch starts at a dash: it becomes the end of the sentence before it.
  if (!html) return text.split(seeded).join(`.${words ? ` ${words}` : ''}`);
  // No sentence left: the space before the seeded sentence goes too.
  return words ? text.split(seeded).join(words) : text.split(` ${seeded}`).join('').split(seeded).join('');
}

// The Automations preview page's one-line summary (never sent), from the same credits as the body.
function nudgePreviewWithOffer(line, offer) {
  if (line !== NUDGE_SEEDED.preview) return line;
  const { friend, member } = nudgeCredits(offer);
  const parts = [friend ? `they get a ${dollars(friend)} credit` : '', member ? `you get a ${dollars(member)} credit` : ''].filter(Boolean);
  return parts.length ? `Refer a neighbor: ${parts.join(', ')}.` : 'Refer a neighbor.';
}

module.exports = {
  STEP2_DEFAULTS, step2Settings, memberCredit, etYearBounds, capReached, ruleTerms, formatDollars,
  friendInviteOfferLine, friendShareClause, memberInviteFriendClause, shareCardOffer, memberCreditEmailLine,
  inviteSmsWithOffer, composerReferralLine, nudgeEmailWithOffer, nudgePreviewWithOffer,
  SEEDED_INVITE_OFFERS, NUDGE_SEEDED,
};
