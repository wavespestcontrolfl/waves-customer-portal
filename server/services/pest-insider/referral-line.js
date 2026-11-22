/**
 * The Waves Pest Insider's referral line: its words, its tokens, and the
 * tokens' value on every surface.
 *
 * The owner's approved words (2026-11-21 "words ok", the Friends & Neighbors
 * words page, Pest Insider row):
 * - until the new referral rules are on (GATE_REFERRAL_STEP2): "Know a
 *   neighbor fighting the same bugs? Send them our way — referrals are the
 *   nicest compliment we get."
 * - after: "Know a neighbor fighting the same bugs? Send them our way. They
 *   get a $50 credit after their first plan service."
 *
 * render.js closes every issue with the line and then the sign-off. In the
 * stored body the line is a token in each part: REFERRAL_TOKEN in the HTML
 * and REFERRAL_TEXT_TOKEN in the text. A stored text never names the amount:
 * the archive serves the body for good, the amount is a setting of the
 * referral program that can change, and the send check refuses a dollar
 * amount in this email. A stored text also cannot follow a pause of the
 * program. So each surface gives the tokens their value, like the "Your
 * home" tokens (home.js):
 * - a surface with no reader and no time of use (the archive, the RSS feed,
 *   an export, the send check) gets the first form, through
 *   neutralizeIssueTokens;
 * - the sender reads the referral program once per batch and gives every
 *   reader of the batch the keys (referralLineForBatch);
 * - the owner's FYI/proof copy and a test send show the line as a reader
 *   would get it at that moment (referralLineAsOfNow).
 *
 * What a reader gets, by the state of the referral program at that moment
 * (referralLineFor, from one read of the live settings row):
 * - an amount to state (GATE_REFERRAL_STEP2 on, the program active, the
 *   live Referee Discount setting above 0): the second form;
 * - the program active and no amount to state: the first form;
 * - the program paused, no live settings row, or a read that failed: no
 *   line. A paused program invites no one, as the share card and the staff
 *   referral link do (referral-share.js, composer-customer-links.js).
 * So what a reader gets always matches what the program pays, and the
 * owner's copy is filled by the same rule as the send.
 *
 * Only an issue of the Waves Pest Insider's own type follows the program.
 * The tokens in any other newsletter get the first form and read nothing.
 * The line promises the member nothing: the body is one text for every
 * reader, and a member at the yearly limit earns no credit.
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
const { neutralizeToolToken } = require('./tool-block');
const { escapeHtml, paragraph, link, wrapBlock } = require('./markup');
const logger = require('../logger');

const REFERRAL_URL = 'https://www.wavespestcontrol.com/referral/';
const REFERRAL_ASK = 'Know a neighbor fighting the same bugs?';
// The link's words: they open REFERRAL_URL.
const REFERRAL_LINK_TEXT = 'Send them our way';
// The first form's end.
const REFERRAL_TAIL = ' — referrals are the nicest compliment we get.';
// Only these exact spellings are the tokens. Neither is a part of the other:
// `{{pi-referral}}` needs its closing braces.
const REFERRAL_TOKEN = '{{pi-referral}}';
const REFERRAL_TEXT_TOKEN = '{{pi-referral-text}}';

const hasReferralToken = (content) => (
  typeof content === 'string' && (content.includes(REFERRAL_TOKEN) || content.includes(REFERRAL_TEXT_TOKEN))
);

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
 * The line with `tail` as its end, as each part of the body holds it: the
 * tokens' values. Each ends the way render.js needs to put the sign-off
 * straight after it.
 * @returns {{ html: string, text: string }}
 */
const referralLine = (tail) => ({
  html: `${wrapBlock({ html: paragraph(`${escapeHtml(REFERRAL_ASK)} ${link(REFERRAL_URL, REFERRAL_LINK_TEXT)}${escapeHtml(tail)}`) })}\n`,
  text: `${REFERRAL_ASK} ${REFERRAL_LINK_TEXT}${tail}\n${REFERRAL_URL}\n\n`,
});
// The tokens' values for no line: the issue exactly as it is without one.
const NO_LINE = Object.freeze({ html: '', text: '' });

// `content` with `line` ({ html, text }) in the place of the tokens; with no line given it comes back as it is.
const fillReferralLine = (content, line) => (
  typeof content === 'string' && line
    ? content.split(REFERRAL_TEXT_TOKEN).join(line.text).split(REFERRAL_TOKEN).join(line.html)
    : content
);

/**
 * A Waves Pest Insider issue's tokens as every surface with no reader shows
 * them: the "A tool we'd use" token and the "Your home" tokens go, and the
 * referral line stands in its first form. The one function such a surface calls (the archive, the RSS feed and
 * the touchpoint body through newsletter-draft.js stripPersonalizationTokens,
 * the blog export, the send check, the sample script).
 */
function neutralizeIssueTokens(content) {
  const bare = neutralizeToolToken(neutralizeHomeTokens(content));
  return hasReferralToken(bare) ? fillReferralLine(bare, referralLine(REFERRAL_TAIL)) : bare;
}

/**
 * The line for `send` as of now ({ html, text }), by the state of the
 * referral program. ONE read of the live settings row (referral-engine
 * getLiveSettings) decides both the program's state and the amount, so the
 * two cannot disagree:
 * - the program paused, no live row, or a read that threw (one warning): no
 *   line. Only an affirmative active value keeps the line. This never stops
 *   a send or a copy;
 * - the program active and an amount to state (step2FriendCreditCentsOf of
 *   that row above 0: the gate on, the setting above 0): the second form;
 * - the program active and no amount to state: the first form.
 * Any other newsletter gets the first form and reads nothing.
 * @param {object} send the newsletter_sends row
 */
async function referralLineFor(send) {
  if (send?.newsletter_type !== PEST_INSIDER_TYPE) return referralLine(REFERRAL_TAIL);
  try {
    const engine = require('../referral-engine');
    const live = await engine.getLiveSettings();
    if (!live?.program_active) return NO_LINE;
    return referralLine(referralTail(engine.step2FriendCreditCentsOf(live)));
  } catch (err) {
    logger.warn(`[newsletter] Waves Pest Insider referral line: the referral program could not be read, the issue goes without the line: ${err.message}`);
    return NO_LINE;
  }
}

/**
 * The line for ONE batch of `send`, whose mailed parts are `content`: read
 * once for the batch, so a change of the setting, of the gate or of the
 * program's state applies from the next batch on.
 * - substitutions: both keys for every reader of the batch when a part
 *   holds a token (a missing key would mail the raw token), and none when no
 *   part does (then nothing is read);
 * - fill(part): a stored part with the same values in the place of the
 *   tokens, for the batch's touchpoints.
 * @param {object} send the newsletter_sends row
 * @param {string} content the mailed HTML and text
 */
async function referralLineForBatch(send, content) {
  const line = hasReferralToken(content) ? await referralLineFor(send) : null;
  return {
    substitutions: line ? { [REFERRAL_TOKEN]: line.html, [REFERRAL_TEXT_TOKEN]: line.text } : {},
    fill: (part) => fillReferralLine(part, line),
  };
}

/**
 * Bodies with the line as a reader would get it now: for the owner's
 * FYI/proof copy and a test send (newsletter-proof.js renderSendPreview).
 * Each part is filled on its own. Bodies with no token come back as given,
 * and nothing is read.
 * @param {object} send the newsletter_sends row
 * @param {{ html: string, text?: string|null }} body
 */
async function referralLineAsOfNow(send, body) {
  if (!hasReferralToken(body.html) && !hasReferralToken(body.text)) return body;
  const line = await referralLineFor(send);
  return { ...body, html: fillReferralLine(body.html, line), text: fillReferralLine(body.text, line) };
}

module.exports = {
  REFERRAL_URL, REFERRAL_ASK, REFERRAL_LINK_TEXT, REFERRAL_TAIL, REFERRAL_TOKEN, REFERRAL_TEXT_TOKEN, NO_LINE,
  hasReferralToken, fillReferralLine, neutralizeIssueTokens, referralTail, referralLine,
  referralLineFor, referralLineForBatch, referralLineAsOfNow,
};
