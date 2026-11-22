/**
 * The Waves Pest Insider's referral line: its words, its token, and the
 * token's value on every surface.
 *
 * The owner's approved words (2026-11-21 "words ok", the Friends & Neighbors
 * words page, Pest Insider row):
 * - until the new referral rules are on (GATE_REFERRAL_STEP2): "Know a
 *   neighbor fighting the same bugs? Send them our way — referrals are the
 *   nicest compliment we get."
 * - after: "Know a neighbor fighting the same bugs? Send them our way. They
 *   get a $50 credit after their first plan service."
 *
 * The two forms differ only in the line's end (its "tail"). render.js writes
 * the line into every issue above the sign-off with REFERRAL_TAIL_TOKEN in
 * the place of the end, in both parts, and the stored body keeps the token.
 * A stored text never names the amount: the archive serves the body for
 * good, the amount is a setting of the referral program that can change, and
 * the send check refuses a dollar amount in this email. Each surface gives
 * the token its value, like the "Your home" tokens (home.js):
 * - a surface with no reader and no time of use (the archive, the RSS feed,
 *   an export, the send check) gets the first form's end, through
 *   neutralizeIssueTokens;
 * - the sender reads the live setting once per batch and gives every reader
 *   of the batch the key (referralTailSubstitution);
 * - the owner's FYI/proof copy and a test send show the line as a reader
 *   would get it at that moment (referralLineAsOfNow).
 * So what a reader gets always matches what the setting pays, and the
 * owner's copy is filled by the same rule as the send.
 *
 * Only an issue of the Waves Pest Insider's own type gets the live end. The
 * token in any other newsletter gets the first form's end and reads no
 * setting. The line promises the member nothing: the body is one text for
 * every reader, and a member at the yearly limit earns no credit.
 *
 * The link opens the Waves website's referral page. That page is one of the
 * static texts of the Step 2 flip day (docs/gates-and-env.md,
 * GATE_REFERRAL_STEP2): it names the old, smaller amount until its own words
 * change, last.
 *
 * This file loads no renderer (like home.js), so every surface can load it
 * for every newsletter.
 */
const { PEST_INSIDER_TYPE } = require('../../config/newsletter-types');
const { memberInviteFriendClause } = require('../referral-step2');
const { neutralizeHomeTokens } = require('./home');
const logger = require('../logger');

const REFERRAL_URL = 'https://www.wavespestcontrol.com/referral/';
const REFERRAL_ASK = 'Know a neighbor fighting the same bugs?';
// The link's words: they open REFERRAL_URL.
const REFERRAL_LINK_TEXT = 'Send them our way';
// The first form's end: the token's value wherever there is no amount to state.
const REFERRAL_TAIL = ' — referrals are the nicest compliment we get.';
// One token for both parts: every value is plain words, digits, "$" and ".",
// which HTML shows as written. Only this exact spelling is the token.
const REFERRAL_TAIL_TOKEN = '{{pi-referral-tail}}';

const hasReferralToken = (content) => typeof content === 'string' && content.includes(REFERRAL_TAIL_TOKEN);
// `content` with `tail` in the place of the token; with no tail it comes back as given.
const fillReferralTail = (content, tail) => (
  typeof content === 'string' && typeof tail === 'string' ? content.split(REFERRAL_TAIL_TOKEN).join(tail) : content
);

/**
 * A Waves Pest Insider issue's tokens as every surface with no reader shows
 * them: the "Your home" tokens go, and the referral line ends in its first
 * form. The one function such a surface calls (the archive, the RSS feed and
 * the touchpoint body through newsletter-draft.js stripPersonalizationTokens,
 * the blog export, the send check).
 */
const neutralizeIssueTokens = (content) => fillReferralTail(neutralizeHomeTokens(content), REFERRAL_TAIL);

/**
 * The end of the line for the friend's credit in cents: ". They get a $50
 * credit after their first plan service." in the words of referral-step2.js,
 * or the first form's end when there is no amount to state. The amount comes
 * only from the setting, the way an event's price comes only from its record.
 */
function referralTail(cents) {
  if (!Number.isInteger(cents) || cents <= 0) return REFERRAL_TAIL;
  const clause = memberInviteFriendClause(cents);
  return `. ${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

/**
 * The token's value for `send` as of now. For a Waves Pest Insider issue:
 * the end for the live Referee Discount setting (referral-engine
 * step2FriendCreditCents gives 0 with GATE_REFERRAL_STEP2 off, the program
 * paused, or the setting unreadable). A read that throws logs one warning
 * and gives the first form's end, so it never stops a send or a copy. Any
 * other newsletter gets the first form's end and reads nothing.
 * @param {object} send the newsletter_sends row
 */
async function referralTailFor(send) {
  if (send?.newsletter_type !== PEST_INSIDER_TYPE) return REFERRAL_TAIL;
  try {
    return referralTail(await require('../referral-engine').step2FriendCreditCents());
  } catch (err) {
    logger.warn(`[newsletter] Waves Pest Insider referral line: the friend's credit could not be read, the line ends in its first form: ${err.message}`);
    return REFERRAL_TAIL;
  }
}

/**
 * The token's substitution for ONE batch of `send`, whose mailed parts are
 * `content`: every reader of the batch gets the key when a part holds the
 * token (a missing key would mail the raw token), and no key when none does.
 * Read per batch, so a change of the setting or of the gate applies from the
 * next batch on.
 * @param {object} send the newsletter_sends row
 * @param {string} content the mailed HTML and text
 */
async function referralTailSubstitution(send, content) {
  return hasReferralToken(content) ? { [REFERRAL_TAIL_TOKEN]: await referralTailFor(send) } : {};
}

/**
 * Bodies with the line as a reader would get it now: for the owner's
 * FYI/proof copy and a test send (newsletter-proof.js renderSendPreview).
 * Bodies with no token come back as given, and nothing is read.
 * @param {object} send the newsletter_sends row
 * @param {{ html: string, text?: string|null }} body
 */
async function referralLineAsOfNow(send, body) {
  if (!hasReferralToken(body.html) && !hasReferralToken(body.text)) return body;
  const tail = await referralTailFor(send);
  return { ...body, html: fillReferralTail(body.html, tail), text: fillReferralTail(body.text, tail) };
}

module.exports = {
  REFERRAL_URL, REFERRAL_ASK, REFERRAL_LINK_TEXT, REFERRAL_TAIL, REFERRAL_TAIL_TOKEN,
  hasReferralToken, fillReferralTail, neutralizeIssueTokens, referralTail,
  referralTailFor, referralTailSubstitution, referralLineAsOfNow,
};
