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
//  - The PDF is a permanent copy (the link 404s after an invalidation, the
//    file does not), so a PDF-bearing send also carries a FINAL fence at the
//    provider boundary (pdfProviderHandoff): the row must be unchanged since
//    the render and not invalidated / call-side blocked. A failed fence skips
//    the send, as the manual sender does (estimateInvalidatedJustBeforeHandoff).
//  - A failed PDF-bearing send is retried by the provider-retry rail, which
//    rebuilds the PDF (or drops the note) through prepareRetryPdf below.
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
// The delivery email builds its own PDF (admin-estimates.js) but its row is
// retried by the same rail, so the rail's allowlist adds it.
const RETRY_KEY_SET = new Set([...ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS, 'estimate.delivery']);

const NONE = Object.freeze({ attachments: [], payload: {} });

// Identity + pricing columns the document prints (the annual guard's
// fingerprint list, plus the link token and the printed expiry). estimate_data
// is not hashed whole: views and charge jobs stamp unrelated keys into it all
// day. The call-derived changes that matter live in the markers the fence
// reads, and in the three linkage keys added below.
const FENCE_COLUMNS = [
  'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
  'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
  'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category',
  'source', 'token', 'expires_at',
];

function parseData(row) {
  const raw = row?.estimate_data;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return null; }
}

function rowFingerprint(row) {
  const data = parseData(row) || {};
  const pick = {};
  for (const c of FENCE_COLUMNS) {
    const v = row?.[c];
    pick[c] = v instanceof Date ? v.toISOString() : (v === undefined ? null : v);
  }
  pick.lead_id = data.lead_id || null;
  pick.lead_linkage = data.lead_linkage || null;
  pick.call_log_id = data.estimatorEngine?.callLogId || null;
  return JSON.stringify(pick);
}

// Why the row may no longer go out with a PDF, or null. Same verdicts the
// manual sender repeats right before its handoff.
async function handoffBlockReason(estimateId, expectedFingerprint) {
  const row = await db('estimates').where({ id: estimateId }).first();
  if (!row) return 'estimate_missing';
  if (row.archived_at || !['sent', 'viewed'].includes(row.status)) return 'estimate_not_open';
  if (rowFingerprint(row) !== expectedFingerprint) return 'estimate_changed_since_render';
  const data = parseData(row);
  if (data === null) return 'estimate_data_unreadable';
  const { estimateOffCustomerSurface, callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  if (estimateOffCustomerSurface({ estimate_data: data })) return 'estimate_invalidated';
  const callBlock = await callSideBlockForEstimateData(db, data, { estimateStatus: row.status });
  if (callBlock) return `call_side_${callBlock}`;
  const { staleCallLinkageReason } = require('./admin-estimate-persistence');
  const stale = await staleCallLinkageReason(db, data, { estimateStatus: row.status });
  if (stale) return `call_linkage_${stale}`;
  return null;
}

// sendOne awaits this after its own preparation, right before the request.
// A veto is a definite non-send (providerBoundaryBlocked); a failed read is a
// definite non-send too, tagged so the library settles it retryable.
function pdfBoundaryCheck(estimateId, expectedFingerprint) {
  return async () => {
    let reason;
    try {
      reason = await handoffBlockReason(estimateId, expectedFingerprint);
    } catch (err) {
      const unavailable = new Error(`estimate ${estimateId} PDF fence unavailable: ${err.message}`);
      unavailable.providerBoundaryCheckFailed = true;
      unavailable.cause = err;
      throw unavailable;
    }
    if (reason) {
      const veto = new Error(`estimate ${estimateId} not sent with a PDF: ${reason}`);
      veto.providerBoundaryBlocked = true;
      veto.reason = reason;
      throw veto;
    }
    return { ok: true };
  };
}

// For sendTemplate({ withProviderHandoff }).
function pdfProviderHandoff(estimateId, expectedFingerprint) {
  const check = pdfBoundaryCheck(estimateId, expectedFingerprint);
  return async (dispatch) => {
    await dispatch(undefined, check);
    return { ok: true };
  };
}

// `validThrough`: the date the document should advertise when the caller
// knows a newer one than the stored row (an extension in flight).
async function openEstimateEmailPdf({ estimateId, templateKey, validThrough = null, now = new Date(), forRetry = false }) {
  try {
    if (!(forRetry ? RETRY_KEY_SET : KEY_SET).has(templateKey)) return NONE;
    if (!featureGates.isEnabled('estimateEmailPdf') || !featureGates.isEnabled('estimateDocPdf')) return NONE;
    const fresh = await db('estimates').where({ id: estimateId }).first();
    if (!fresh || !fresh.token) return NONE;
    if (!['sent', 'viewed'].includes(fresh.status) || fresh.archived_at) return NONE;
    const effectiveExpiry = validThrough || fresh.expires_at;
    if (effectiveExpiry && new Date(effectiveExpiry).getTime() <= now.getTime()) return NONE;
    const pdf = require('./pdf/estimate-doc-pdf');
    const attachment = await pdf.buildEstimateEmailPdfAttachment(fresh, { validThrough: validThrough || fresh.expires_at || null });
    if (!attachment) return NONE;
    const fingerprint = rowFingerprint(fresh);
    return {
      attachments: [attachment],
      payload: { estimate_pdf_note: pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp },
      // Pass to sendTemplate: the final fence for the permanent copy.
      withProviderHandoff: pdfProviderHandoff(estimateId, fingerprint),
      boundaryCheck: pdfBoundaryCheck(estimateId, fingerprint),
    };
  } catch (e) {
    logger.warn(`[estimate-email-pdf] skipped for estimate ${estimateId}: ${String(e?.message || e).slice(0, 200)}`);
    return NONE;
  }
}

// ---- Provider-retry rail --------------------------------------------------
// A PDF-bearing row keeps has_attachments = true and the attachment is not
// stored, so the rail cannot replay the stored copy alone. It rebuilds the
// PDF from the live row; with none to give (estimate no longer open, render
// failed, gate off) it sends the body only with the note line removed, so the
// copy never promises a file that is missing. Returns:
//   { attachments, boundaryCheck }            PDF rebuilt (fence included)
//   { attachments: [], html, text }           body only, note stripped
//   { unsendable: true }                      note could not be removed
const ESTIMATE_PDF_RETRY_TEMPLATE_KEYS = Object.freeze([...RETRY_KEY_SET]);

function isRetryTemplate(templateKey) {
  return RETRY_KEY_SET.has(templateKey);
}

function stripPdfNote(html, text) {
  const { renderBlocks } = require('./email-template-library');
  const pdf = require('./pdf/estimate-doc-pdf');
  for (const note of Object.values(pdf.ESTIMATE_EMAIL_PDF_NOTES)) {
    const textHas = typeof text === 'string' && text.includes(note);
    const frag = renderBlocks([{ type: 'small_note', content: '{{estimate_pdf_note}}' }], { estimate_pdf_note: note });
    const htmlHas = typeof html === 'string' && frag.bodyHtml && html.includes(frag.bodyHtml);
    if (!textHas && !htmlHas) continue;
    if (!textHas || !htmlHas) return null;
    // renderBlocks joins its parts with a newline: drop the fragment with one.
    const nextHtml = html.includes(`\n${frag.bodyHtml}`) ? html.replace(`\n${frag.bodyHtml}`, '')
      : html.includes(`${frag.bodyHtml}\n`) ? html.replace(`${frag.bodyHtml}\n`, '')
        : html.replace(frag.bodyHtml, '');
    const nextText = text.includes(`${note}\n\n`) ? text.replace(`${note}\n\n`, '')
      : text.includes(`\n\n${note}`) ? text.replace(`\n\n${note}`, '')
        : text.replace(note, '');
    return { html: nextHtml, text: nextText };
  }
  return null;
}

async function prepareRetryPdf(message) {
  const copy = message.estimate_id
    ? await openEstimateEmailPdf({ estimateId: message.estimate_id, templateKey: message.template_key, forRetry: true })
    : NONE;
  if (copy.attachments.length) return { attachments: copy.attachments, boundaryCheck: copy.boundaryCheck };
  const stripped = stripPdfNote(message.html_snapshot, message.text_snapshot);
  if (!stripped) return { unsendable: true };
  return { attachments: [], html: stripped.html, text: stripped.text };
}

module.exports = {
  openEstimateEmailPdf,
  ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS,
  ESTIMATE_PDF_RETRY_TEMPLATE_KEYS,
  isRetryTemplate,
  prepareRetryPdf,
  stripPdfNote,
  rowFingerprint,
  handoffBlockReason,
};
