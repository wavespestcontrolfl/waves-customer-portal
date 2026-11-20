'use strict';

/**
 * Cancel-flow reason pick → churn taxonomy, and what the AI churn classifier
 * may read.
 *
 * The customer (portal cancel flow) or the office (Cancel plan dialog) picks
 * one of the v2 cancel reasons (cancellation-resolution/reason-codes.js).
 * That pick IS the churn reason, so the processor writes it straight to
 * customers.churn_reason_code (CHECK list in migration
 * 20260704180000_customers_churn_taxonomy.js) with no AI call. A pick with no
 * churn counterpart maps to 'other', which the AI may still refine from the
 * customer's or the office's own words.
 *
 * Why (prod read 2026-11-19): 40 of 40 churned customers since July had no
 * code. The processor classified only `reason`, and on the portal path that
 * is "Portal cancellation request <id>" (on an office cancel with no pick,
 * "Admin cancellation request <id>"): the AI read an id, never the pick or
 * the words.
 *
 * Migration 20261120090000_churn_code_four_picked_cancels.js coded four
 * existing churns with this map (a test pins that its rows agree).
 */

const CANCEL_TO_CHURN = Object.freeze({
  price: 'price',
  results_pest: 'results',
  results_lawn: 'results',
  service_experience: 'service_quality',
  scheduling_access_communication: 'service_quality',
  damage_or_adverse_effect: 'service_quality',
  away: 'seasonal_pause',
  moving_or_property_change: 'moving',
  no_longer_needed: 'no_longer_needed',
  diy: 'no_longer_needed',
  competitor: 'competitor',
  financial_hardship: 'financial',
  service_mix: 'other',
  hoa_or_landlord: 'other',
  health_or_chemicals: 'other',
  billing_issue: 'other',
  unexpected_recurring: 'other',
  personal_circumstances: 'other',
  other: 'other',
});

// Text the system writes, not a person: the processor's default, and the
// request-id reasons the portal and admin paths pass.
const SYSTEM_REASON_RES = Object.freeze([
  /^customer cancellation request\.?$/i,
  /^(portal|admin) cancellation request\s+[0-9a-f-]{8,}$/i,
]);

// The portal cancel form's description (client CancelFlow.jsx, both the
// scoped and the legacy form): "Customer requested cancellation[ of <plan>].
// Reason: <label or 'Not specified'>. Details: <text or 'None'>".
const PORTAL_FORM_RE = /^Customer requested cancellation(?: of [^.]*)?\. Reason: ([\s\S]*?)\. Details: ([\s\S]*)$/;

/** The churn code for a v2 cancel reason pick, or null (no pick / unknown). */
function churnCodeForCancelReason(cancelReasonCode) {
  if (cancelReasonCode == null) return null;
  const key = String(cancelReasonCode);
  return Object.prototype.hasOwnProperty.call(CANCEL_TO_CHURN, key) ? CANCEL_TO_CHURN[key] : null;
}

// The words in a portal form description: the reason label only when there
// was no pick (with a pick the label just repeats it), the details unless the
// form's placeholder. Text that is not the form comes back as is.
function portalFormWords(text, { picked }) {
  const match = PORTAL_FORM_RE.exec(text);
  if (!match) return text;
  const label = match[1].trim();
  const details = match[2].trim();
  const parts = [];
  if (!picked && label && label !== 'Not specified') parts.push(`Reason: ${label}`);
  if (details && details !== 'None') parts.push(`Details: ${details}`);
  return parts.join('. ');
}

/**
 * What the AI churn classifier reads, or null for no call.
 *   cancelReasonCode  the v2 pick, if any
 *   words             the customer's or the office's own words, if the
 *                     caller has them (portal description, office note)
 *   reason            the processor's `reason`, read only when the caller
 *                     passed neither a pick nor words (older callers)
 * A specific pick needs no AI. The system's own reason text and the portal
 * form's placeholders are never sent (they can only come back
 * 'unclassified'). Capped at 500 characters.
 */
function churnClassifierInput({ cancelReasonCode = null, words = null, reason = null } = {}) {
  const picked = churnCodeForCancelReason(cancelReasonCode);
  if (picked && picked !== 'other') return null;
  let text;
  if (words != null) text = portalFormWords(String(words).trim(), { picked: Boolean(picked) });
  else if (cancelReasonCode == null) text = String(reason == null ? '' : reason).trim();
  else return null; // a pick and no words: `reason` is built from the pick
  if (!text || SYSTEM_REASON_RES.some((re) => re.test(text))) return null;
  return text.slice(0, 500);
}

module.exports = {
  CANCEL_TO_CHURN,
  churnCodeForCancelReason,
  churnClassifierInput,
};
