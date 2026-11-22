/**
 * The Waves Pest Insider's referral line: its words, and its end at the time
 * of use.
 *
 * The owner's approved words (2026-11-21 "words ok", the Friends & Neighbors
 * words page, Pest Insider row):
 * - until the new referral rules are on (GATE_REFERRAL_STEP2): "Know a
 *   neighbor fighting the same bugs? Send them our way — referrals are the
 *   nicest compliment we get."
 * - after: "Know a neighbor fighting the same bugs? Send them our way. They
 *   get a $50 credit after their first plan service."
 *
 * render.js writes the first form into every issue, above the sign-off, and
 * the stored body holds it for good. The second names an amount, and a
 * stored text must not: the archive serves the body as stored, the amount is
 * a setting of the referral program that can change, and the send check
 * refuses a dollar amount in this email. So the line's end (its "tail") is
 * put in at the time of use, from the live setting: by the sender for each
 * batch, and by the owner's copy and a test send for the moment they are
 * made. A stored text can then never promise more than the setting pays.
 *
 * The line promises the member nothing: the body is one text for every
 * reader, and a member at the yearly limit earns no credit.
 *
 * Only an issue of the Waves Pest Insider's own type is touched, and only
 * where its body holds the line's end as render.js wrote it. Any other
 * newsletter, and an issue whose line was edited by hand, keeps its body.
 *
 * This file loads no renderer (like home.js), so the sender and the owner's
 * copy can load it for every newsletter.
 */
const { PEST_INSIDER_TYPE } = require('../../config/newsletter-types');
const { memberInviteFriendClause } = require('../referral-step2');
const logger = require('../logger');

const REFERRAL_URL = 'https://www.wavespestcontrol.com/referral/';
const REFERRAL_ASK = 'Know a neighbor fighting the same bugs?';
// The link's words: they open REFERRAL_URL.
const REFERRAL_LINK_TEXT = 'Send them our way';
const REFERRAL_TAIL = ' — referrals are the nicest compliment we get.';
// One token for both parts: every tail is plain words, digits, "$" and ".",
// which HTML shows as written.
const REFERRAL_TAIL_TOKEN = '{{pi-referral-tail}}';

// The line's end as each part of a rendered issue holds it: in HTML from the
// link's close to the paragraph's close, in text up to the address on the
// line below.
const htmlEnd = (tail) => `>${REFERRAL_LINK_TEXT}</a>${tail}</p>`;
const textEnd = (tail) => `${REFERRAL_LINK_TEXT}${tail}\n${REFERRAL_URL}\n`;

/**
 * A copy of an issue's bodies with `tail` as the end of the referral line, in
 * the place of the stored one. `tail` is a referralTail value, or
 * REFERRAL_TAIL_TOKEN for the sender. A body without the stored end comes
 * back with the same parts. The stored body is never changed.
 * @param {{ html: string, text?: string|null }} body
 * @param {string} tail
 */
function withReferralTail({ html, text }, tail) {
  return {
    html: String(html || '').split(htmlEnd(REFERRAL_TAIL)).join(htmlEnd(tail)),
    text: typeof text === 'string' ? text.split(textEnd(REFERRAL_TAIL)).join(textEnd(tail)) : text,
  };
}

/**
 * The end of the line for the friend's credit in cents: ". They get a $50
 * credit after their first plan service." in the words of referral-step2.js,
 * or the stored end when there is no amount to state. The amount comes only
 * from the setting, the way an event's price comes only from its record.
 */
function referralTail(cents) {
  if (!Number.isInteger(cents) || cents <= 0) return REFERRAL_TAIL;
  const clause = memberInviteFriendClause(cents);
  return `. ${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

const isIssue = (send) => send?.newsletter_type === PEST_INSIDER_TYPE;

// The end of the line as of now. referral-engine step2FriendCreditCents gives
// the live Referee Discount setting while the new referral rules are on, and
// 0 with GATE_REFERRAL_STEP2 off, the program paused, or the setting
// unreadable: then the line ends as stored. A read that throws logs one
// warning and gives the stored end too, so it never stops a send or a copy.
async function liveReferralTail() {
  try {
    return referralTail(await require('../referral-engine').step2FriendCreditCents());
  } catch (err) {
    logger.warn(`[newsletter] Waves Pest Insider referral line: the friend's credit could not be read, the line ends as stored: ${err.message}`);
    return REFERRAL_TAIL;
  }
}

/**
 * The sender's own copy of an issue's bodies, with a token in the place of
 * the stored end. `token` is the token when the copy holds it, else null
 * (nothing to fill).
 * @param {object} send the newsletter_sends row
 * @param {{ html: string, text?: string|null }} body
 * @returns {{ body: { html: string, text?: string|null }, token: string|null }}
 */
function referralTokenCopy(send, body) {
  if (!isIssue(send)) return { body, token: null };
  const copy = withReferralTail(body, REFERRAL_TAIL_TOKEN);
  const held = [copy.html, copy.text].some((part) => typeof part === 'string' && part.includes(REFERRAL_TAIL_TOKEN));
  return { body: copy, token: held ? REFERRAL_TAIL_TOKEN : null };
}

/**
 * The token's substitution for ONE batch: every reader of the batch gets the
 * key (a missing key would mail the raw token). Read per batch, so a change
 * of the setting or of the gate applies from the next batch on.
 * @param {string|null} token referralTokenCopy's token
 */
async function referralTailSubstitution(token) {
  return token ? { [token]: await liveReferralTail() } : {};
}

/**
 * An issue's bodies with the line as a reader would get it now: for the
 * owner's copy and a test send (newsletter-proof.js renderSendPreview).
 * @param {object} send the newsletter_sends row
 * @param {{ html: string, text?: string|null }} body
 */
async function referralLineAsOfNow(send, body) {
  return isIssue(send) ? withReferralTail(body, await liveReferralTail()) : body;
}

module.exports = {
  REFERRAL_URL, REFERRAL_ASK, REFERRAL_LINK_TEXT, REFERRAL_TAIL, REFERRAL_TAIL_TOKEN,
  withReferralTail, referralTail,
  referralTokenCopy, referralTailSubstitution, referralLineAsOfNow,
};
