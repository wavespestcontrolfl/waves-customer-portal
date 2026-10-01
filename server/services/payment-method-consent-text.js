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
const CONSENT_VERSION = 'v11_2026-08-25';

// v12 (GATE_PAY_AFTER_FIRST_VISIT, owner ruling 2026-09-30): the AFTER-VISIT
// variants below authorize the first charge AFTER the first visit is
// completed instead of at approval. They carry their own label and do NOT
// bump CONSENT_VERSION: the base card/ACH/prepay texts are unchanged, so
// gate-off behavior and every existing consent row stay byte-identical.
// Label length is capped by payment_method_consents.consent_text_version
// (varchar 20). v12 clears the v8+ enrollment bar
// (consentVersionQualifiesForEnrollment).
const AFTER_VISIT_CONSENT_VERSION = 'v12_2026-09-30';

const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization. I can revoke anytime — email',
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
  'until I revoke this authorization. I may revoke by writing to',
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
  'as agreed (including plan renewals), until I revoke authorization. I',
  'can revoke anytime — email billing@wavespestcontrol.com, call',
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
  'amount of that invoice, until I revoke this authorization. I may',
  `revoke by writing to billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY}`,
  'at least 3 business days before the next scheduled debit. I may',
  'request a copy of this authorization at any time by contacting Waves',
  'at the email or phone above. I can manage or remove saved payment',
  'methods anytime in my customer portal. Bank transfers have no added',
  'card surcharge.',
].join(' ');

// Pay-after-first-visit card capture (GATE_PAY_AFTER_FIRST_VISIT): nothing is
// charged at approval; the saved card is charged for the first visit's
// invoice (incl. any one-time setup fee) once that visit is completed, and
// for future invoices as agreed.
const AFTER_VISIT_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it after my first service visit is completed for',
  'that visit\'s invoice (including any one-time setup fee), and for future',
  'service visits and invoices as agreed, until I revoke authorization.',
  'Nothing is charged today. I can revoke anytime — email',
  `billing@wavespestcontrol.com, call ${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the`,
  'card in the Waves app or my customer portal. A credit card surcharge',
  'of up to 2.9% may apply; the exact surcharge and total will be shown',
  'before payment. Debit cards, prepaid cards, and bank transfers have',
  'no added card surcharge.',
].join(' ');

// Annual prepay, card, charged after the first visit. The amount is the
// exact total shown at approval, or LOWER if account credit applies by then
// — never higher.
const AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and, after my first service visit is completed, charge it for',
  'my 12-month annual prepay invoice at the exact total shown before I',
  'confirm (or a lower amount if account credit applies, never a higher',
  'amount), and charge it for future invoices as agreed (including plan',
  'renewals), until I revoke authorization. Nothing is charged today. I',
  'can revoke anytime — email billing@wavespestcontrol.com, call',
  `${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the card in the Waves app or my customer`,
  'portal. A credit card surcharge of up to 2.9% may apply; the exact',
  'surcharge and total will be shown before payment. Debit cards, prepaid',
  'cards, and bank transfers have no added card surcharge.',
].join(' ');

// Annual prepay, saved BANK method, debited after the first visit.
const AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate an electronic ACH debit from my saved bank account after my',
  'first service visit is completed for my 12-month annual prepay invoice',
  'at the exact total shown before I confirm (or a lower amount if',
  'account credit applies, never a higher amount), and to initiate',
  'electronic ACH debits from that account for future invoices as agreed',
  '(including plan renewals), each in the amount of that invoice, until I',
  'revoke this authorization. Nothing is debited today. I may revoke by',
  `writing to billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY}`,
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

function getConsentText(methodType, { variant = null } = {}) {
  // Accept both Stripe-style ('us_bank_account') and DB-style ('ach')
  // to be forgiving at call sites.
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    // The prepay variant exists for BOTH tender families (Codex #3492
    // r11): an auto-satisfy prepay accept can debit a saved bank method
    // immediately, and that authorization must be the snapshot of record.
    if (variant === 'prepay_card') return PREPAY_ACH_CONSENT_TEXT;
    // after_visit_prepay: annual prepay debited after the first visit.
    if (variant === 'after_visit_prepay') return AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT;
    // after_visit_card has no bank-specific copy: the base ACH text already
    // authorizes a debit "for each invoice ... on or after its due date",
    // which is exactly a first-visit invoice charged after the visit.
    return ACH_CONSENT_TEXT;
  }
  if (variant === 'prepay_card') return PREPAY_CARD_CONSENT_TEXT;
  if (variant === 'after_visit_prepay') return AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT;
  if (variant === 'after_visit_card') return AFTER_VISIT_CARD_CONSENT_TEXT;
  return CARD_CONSENT_TEXT;
}

// The consent_text_version label a variant's snapshot is recorded under.
// The after-visit variants carry v12; every other variant (including null)
// keeps the global CONSENT_VERSION. An after-visit variant on a bank method
// with no bank-specific copy (after_visit_card) records the base ACH text,
// so it is labelled with the global version too.
const AFTER_VISIT_VARIANTS = new Set(['after_visit_prepay', 'after_visit_card']);
function consentVersionForVariant(variant, methodType = 'card') {
  if (!AFTER_VISIT_VARIANTS.has(variant)) return CONSENT_VERSION;
  const isBank = methodType === 'us_bank_account' || methodType === 'ach';
  if (isBank && variant === 'after_visit_card') return CONSENT_VERSION;
  return AFTER_VISIT_CONSENT_VERSION;
}

module.exports = {
  CONSENT_TEXT,
  CARD_CONSENT_TEXT,
  ACH_CONSENT_TEXT,
  PREPAY_CARD_CONSENT_TEXT,
  PREPAY_ACH_CONSENT_TEXT,
  AFTER_VISIT_CARD_CONSENT_TEXT,
  AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT,
  AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT,
  CONSENT_VERSION,
  AFTER_VISIT_CONSENT_VERSION,
  getConsentText,
  consentVersionForVariant,
};
