// ============================================================
// estimate-email-pdf.js — the PDF copy on open-estimate emails after the
// first one (follow-ups, engagement nudges, extension notices).
//
// Owner ask 2026-10-19: attach the estimate PDF to outgoing estimate emails
// "for customers who can't open the estimate". Gate GATE_ESTIMATE_EMAIL_PDF
// (plus GATE_ESTIMATE_DOC_PDF). The delivery email builds its own PDF in
// admin-estimates.js (it needs the pre-persist valid-through date); every
// other estimate email goes through openEstimateEmailPdf below.
//
// Rules:
//  - Explicit allowlist of templates. deposit_abandoned, payment_step_
//    abandoned and the accepted_* mails are about money or an accepted
//    estimate, not an open one — they never carry the PDF.
//  - The estimate must still be open on a FRESH row read (sent / viewed,
//    not archived, not past its expiry).
//  - A failure returns the empty result: the email is sent exactly as before.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');

const ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS = Object.freeze([
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'estimate.followup_final',
  'estimate.expiring_notice',
  'estimate.engage_unopened',
  'estimate.engage_gone_quiet',
  'estimate.engage_expiring',
  'estimate.engage_expiring_unseen',
  'estimate.engage_high_intent',
  'estimate.engage_return_visit',
  'estimate.engage_return_after_dark',
  'estimate.extended',
  'estimate.extension_notice',
]);
const KEY_SET = new Set(ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS);

const NONE = Object.freeze({ attachments: [], payload: {} });

// `validThrough`: the date the document should advertise when the caller
// knows a newer one than the stored row (an extension in flight).
async function openEstimateEmailPdf({ estimateId, templateKey, validThrough = null, now = new Date() }) {
  try {
    if (!KEY_SET.has(templateKey)) return NONE;
    if (!featureGates.isEnabled('estimateEmailPdf') || !featureGates.isEnabled('estimateDocPdf')) return NONE;
    const fresh = await db('estimates').where({ id: estimateId }).first();
    if (!fresh || !fresh.token) return NONE;
    if (!['sent', 'viewed'].includes(fresh.status) || fresh.archived_at) return NONE;
    const effectiveExpiry = validThrough || fresh.expires_at;
    if (effectiveExpiry && new Date(effectiveExpiry).getTime() <= now.getTime()) return NONE;
    const pdf = require('./pdf/estimate-doc-pdf');
    const attachment = await pdf.buildEstimateEmailPdfAttachment(fresh, { validThrough: validThrough || fresh.expires_at || null });
    if (!attachment) return NONE;
    return { attachments: [attachment], payload: { estimate_pdf_note: pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp } };
  } catch (e) {
    logger.warn(`[estimate-email-pdf] skipped for estimate ${estimateId}: ${String(e?.message || e).slice(0, 200)}`);
    return NONE;
  }
}

module.exports = { openEstimateEmailPdf, ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS };
