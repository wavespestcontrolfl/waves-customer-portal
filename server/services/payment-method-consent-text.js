/**
 * Single source of truth for the saved-payment-method authorization copy.
 *
 * Split by method family because card-on-file and ACH have different
 * regulatory floors:
 *   - Card-on-file: card-network rules + TILA/Reg Z. The card variant
 *     covers scope, revocation, and surcharge.
 *   - ACH (us_bank_account): NACHA Operating Rules + Reg E (12 CFR 1005.10).
 *     The ACH variant adds explicit ACH debit language, amount + frequency,
 *     the 3-business-day revocation timing, and a copy-of-authorization
 *     promise.
 *
 * If you edit either text you MUST bump CONSENT_VERSION. Old consent rows
 * store the version string + a verbatim snapshot so they remain
 * interpretable forever.
 *
 * The client mirror lives at
 *   client/src/lib/paymentMethodConsentText.js
 * and must stay in sync with this file.
 */

const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

// v9 (owner asks 2026-07-12, with the card-on-file booking rollout):
// billing@wavespestcontrol.com named for inquiries/revocation, and removing
// the card in the Waves app or customer portal named as a revocation
// channel alongside email/phone.
// v10 (portal ACH Auto Pay lane 2026-07-13): the ACH variant's revocation
// contact aligned contact@ → billing@ to match the v9 card text. Card text
// unchanged.
// v11 (GATE_PREPAY_CARD_AND_CHARGE, owner ruling 2026-08-25): NEW
// prepay-card variant added — an annual-prepay accept charges the card
// immediately, which the base card text ("future service visits") does not
// plainly authorize. Card + ACH texts unchanged; version bumped because the
// module's vocabulary changed and rows must be interpretable by version.
// v12 (annual rate review disclosed up front, owner ruling 2026-09-30):
// every variant gains one sentence — each invoice is billed at the rate
// then in effect, including rates changed on at least 30 days' written
// notice. NEW consents only: existing v8+ rows keep qualifying for
// enrollment (consentVersionQualifiesForEnrollment is a major-version
// floor, not an equality check), so no existing customer is re-asked
// (owner ruling 2026-08-29: autopay is never re-required).
const CONSENT_VERSION = 'v12_2026-09-30';

// The rate sentence shared by every variant (verbatim owner copy).
const RATE_IN_EFFECT_SENTENCE = 'Each invoice is billed at the rate then in effect, including rates changed on at least 30 days’ written notice.';

const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email',
  `billing@wavespestcontrol.com, call ${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the`,
  'card in the Waves app or my customer portal. A credit card surcharge',
  'of up to 2.9% may apply; the exact surcharge and total will be shown',
  'before payment. Debit cards, prepaid cards, and bank transfers have',
  'no added card surcharge.',
].join(' ');

const ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate electronic ACH debits from the bank account identified',
  'above for each invoice in the amount of that invoice, on or after',
  'its due date (or on the Auto Pay billing day I have selected),',
  'until I revoke this authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I may revoke by writing to',
  `billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY} at least`,
  '3 business days before the next scheduled debit. I may request a',
  'copy of this authorization at any time by contacting Waves at the',
  'email or phone above. I can manage or remove saved payment methods',
  'anytime in my customer portal.',
].join(' ');

// Annual-prepay card capture (GATE_PREPAY_CARD_AND_CHARGE): the accept
// charges the 12-month prepay invoice on this card IMMEDIATELY after
// booking, so the authorization must say so in the same breath as the
// save-for-future consent — the base card text's "future service visits"
// scope does not plainly cover an immediate charge.
const PREPAY_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card, charge it now for my 12-month annual prepay invoice at the',
  'exact total shown before I confirm, and charge it for future invoices',
  'as agreed (including plan renewals), until I revoke authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email billing@wavespestcontrol.com, call',
  `${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the card in the Waves app or my customer`,
  'portal. A credit card surcharge of up to 2.9% may apply; the exact',
  'surcharge and total will be shown before payment. Debit cards, prepaid',
  'cards, and bank transfers have no added card surcharge.',
].join(' ');

// Annual-prepay debit on an already-saved BANK method (Codex #3492 r11):
// an autopay-active/saved-method accept can resolve to an ACH method, and
// the base ACH text's "each invoice … on or after its due date" scope does
// not plainly cover the immediate 12-month debit the accept runs — the
// authorization must say so, mirroring the prepay card variant.
const PREPAY_ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate an electronic ACH debit from my saved bank account now for',
  'my 12-month annual prepay invoice at the exact total shown before I',
  'confirm, and to initiate electronic ACH debits from that account for',
  'future invoices as agreed (including plan renewals), each in the',
  'amount of that invoice, until I revoke this authorization.',
  RATE_IN_EFFECT_SENTENCE,
  `I may revoke by writing to billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY}`,
  'at least 3 business days before the next scheduled debit. I may',
  'request a copy of this authorization at any time by contacting Waves',
  'at the email or phone above. I can manage or remove saved payment',
  'methods anytime in my customer portal. Bank transfers have no added',
  'card surcharge.',
].join(' ');

// Back-compat alias. Anything that imports CONSENT_TEXT without knowing
// the method type defaults to the card variant — keeps onboarding and
// contract code working without a forced refactor in this PR.
const CONSENT_TEXT = CARD_CONSENT_TEXT;

// The phrase that distinguishes BOTH prepay variants (card and ACH) from the
// base texts, in every version that has carried them: recovery evidence for
// an annual-prepay charge is matched on it (codex #5434 r3 P1), because a
// base save-and-charge consent for the same method must never stand in for
// the immediate-charge authorization.
const PREPAY_CONSENT_MARKER = '12-month annual prepay invoice';

// One-time card HOLD (CardHoldModal on the estimate page): the customer reads
// the hold's own disclosure — final total charged after the visit, the
// no-show / late-cancel fee and window, the surcharge line — never the card
// authorization above (codex #5434 r3 P1). Its ledger row snapshots exactly
// that text under its own version (not a 'v<N>' card-copy version, so it can
// never read as Auto Pay enrollment consent; hold rows are also excluded by
// source). Mirror of EstimateViewPage.jsx CardHoldModal — keep in lockstep.
const CARD_HOLD_CONSENT_VERSION = 'card_hold_v1_2026-10-01';
const SURCHARGE_RATE_PHRASE = (CARD_CONSENT_TEXT.match(/up to \d+(?:\.\d+)?%/) || [])[0];
const CARD_SURCHARGE_DISCLOSURE = SURCHARGE_RATE_PHRASE
  ? `A credit card surcharge of ${SURCHARGE_RATE_PHRASE} may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.`
  : 'A credit card surcharge may apply; debit cards, prepaid cards, and bank transfers have no added card surcharge.';
function fmtHoldMoney(n) {
  const v = Math.round(Number(n) * 100) / 100;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function cardHoldConsentText({ noShowFeeAmount = 75, cancelWindowHours = 24 } = {}) {
  const feeText = fmtHoldMoney(noShowFeeAmount != null ? noShowFeeAmount : 75);
  const windowText = `${cancelWindowHours != null ? cancelWindowHours : 24} hours`;
  return `We won’t charge you today. Your card is charged the final total after your visit is completed. A ${feeText} fee applies only if you cancel within ${windowText} or aren’t home. Rescheduling is free but doesn’t reset the cancellation window. ${CARD_SURCHARGE_DISCLOSURE}`;
}

// ── Rendered-version attestation (codex #5434 r1 P1) ──────────────────────
// The client bundles its own copy of this text, so a tab that loaded an
// OLDER bundle keeps rendering the older copy after a deploy bumps this
// module. Every customer-facing request that captures a consent therefore
// carries `consentTextVersion` — the CONSENT_VERSION of the text that tab
// RENDERED beside its checkbox — and the route refuses a capture whose
// version is not this server's current one BEFORE any Stripe work or
// ledger write, with a 409 the client surfaces as "refresh the page".
// A mint route that stamps `consent_text_version` into the Stripe intent's
// metadata lets the webhook mirrors apply the same rule to captures the
// browser never finishes. Existing rows are untouched: the enrollment
// floor (consentVersionQualifiesForEnrollment, v8+) is unchanged, so no
// existing customer is re-asked.
const CONSENT_VERSION_STALE_CODE = 'CONSENT_VERSION_STALE';
const CONSENT_VERSION_STALE_MESSAGE = 'The payment authorization text was updated. Please refresh the page and try again.';
// Stripe metadata key for the version the minting tab rendered.
const CONSENT_VERSION_METADATA_KEY = 'consent_text_version';

/** True only for a request/intent attesting EXACTLY this server's CONSENT_VERSION. */
function renderedConsentVersionIsCurrent(value) {
  return typeof value === 'string' && value.trim() === CONSENT_VERSION;
}

/** True only for an intent whose mint stamped EXACTLY this server's CONSENT_VERSION (metadata.consent_text_version). */
function intentConsentStampIsCurrent(intent) {
  return renderedConsentVersionIsCurrent(intent?.metadata?.[CONSENT_VERSION_METADATA_KEY]);
}

/** The JSON body for the 409 a capture route answers a stale (or absent) attestation with. */
function consentVersionStaleResponse() {
  return { error: CONSENT_VERSION_STALE_MESSAGE, code: CONSENT_VERSION_STALE_CODE };
}

/** Error form of the same refusal, for service-layer captures that throw. */
function consentVersionStaleError() {
  const err = new Error(CONSENT_VERSION_STALE_MESSAGE);
  err.status = 409;
  err.code = CONSENT_VERSION_STALE_CODE;
  return err;
}

function getConsentText(methodType, { variant = null, holdTerms = null } = {}) {
  // A one-time card hold snapshots the hold disclosure the customer read.
  if (variant === 'card_hold') return cardHoldConsentText(holdTerms || {});
  // Accept both Stripe-style ('us_bank_account') and DB-style ('ach')
  // to be forgiving at call sites.
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    // The prepay variant exists for BOTH tender families (Codex #3492
    // r11): an auto-satisfy prepay accept can debit a saved bank method
    // immediately, and that authorization must be the snapshot of record.
    if (variant === 'prepay_card') return PREPAY_ACH_CONSENT_TEXT;
    return ACH_CONSENT_TEXT;
  }
  if (variant === 'prepay_card') return PREPAY_CARD_CONSENT_TEXT;
  return CARD_CONSENT_TEXT;
}

module.exports = {
  CONSENT_TEXT,
  CARD_CONSENT_TEXT,
  ACH_CONSENT_TEXT,
  PREPAY_CARD_CONSENT_TEXT,
  PREPAY_ACH_CONSENT_TEXT,
  RATE_IN_EFFECT_SENTENCE,
  PREPAY_CONSENT_MARKER,
  CARD_HOLD_CONSENT_VERSION,
  cardHoldConsentText,
  CONSENT_VERSION,
  CONSENT_VERSION_STALE_CODE,
  CONSENT_VERSION_STALE_MESSAGE,
  CONSENT_VERSION_METADATA_KEY,
  renderedConsentVersionIsCurrent,
  intentConsentStampIsCurrent,
  consentVersionStaleResponse,
  consentVersionStaleError,
  getConsentText,
};
