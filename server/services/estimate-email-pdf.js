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
//  - A PDF-bearing row (has_attachments) is NOT on the provider-retry rail,
//    as on main: a failed one is retried by the follow-up sweep re-running
//    the whole touch through every check above (see sendDualChannel).
// ============================================================

const crypto = require('crypto');
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
]);
const KEY_SET = new Set(ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS);
const NONE = Object.freeze({ attachments: [], payload: {} });

// Identity + pricing columns the document prints (the annual guard's
// fingerprint list, plus the link token and the printed expiry).
const FENCE_COLUMNS = [
  'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
  'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
  'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category',
  'source', 'token', 'expires_at',
];

// estimate_data keys that are bookkeeping, not document content: the writers
// stamp them all day (view counting, delivery and send receipts, charge jobs,
// accept-time setup, lead-handoff witnesses, rate-review terms served, the
// estimator engine's claim and marker object). Everything else in
// estimate_data is hashed, so a content key added later is covered by default
// (an exclusion list, not an inclusion list). The engine object is judged by
// the markers the fence reads; only its callLogId stays in the hash.
const BOOKKEEPING_KEYS = new Set([
  'estimatorEngine', 'viewedMonthlyTotal', 'prepayAutoChargeJob', 'deliveryState', 'sendSnapshot',
  'manualSendAttempts', 'rateReviewTermsServed', 'rateReviewDisclosedAtAccept', 'pricingAuthorityAtLock',
  'acceptedRecurringCardSetupIntentId', 'acceptedRecurringCardSkipEnrollment', 'acceptedSetupFeeAmount',
  'leadServiceHandoffAttempt', 'leadServiceHandoffAt', 'leadServiceRevertPending', 'reportCtaMint',
  'retiredBySentEstimate', 'automation', 'assessment_exception', 'scheduled_service_id',
  'addressUnverifiedClearedBy', 'addressUnverifiedFlag',
]);

function parseData(row) {
  const raw = row?.estimate_data;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return null; }
}

// Key-sorted JSON so the same content always hashes the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function contentProjection(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (!BOOKKEEPING_KEYS.has(k)) out[k] = v;
  }
  out.__callLogId = data?.estimatorEngine?.callLogId || null;
  return out;
}

// `omitExpiry`: the manual delivery send persists expires_at later in its own
// flow and pins the printed date, so its fence leaves the column out.
function rowFingerprint(row, { omitExpiry = false } = {}) {
  const pick = {};
  for (const c of FENCE_COLUMNS) {
    if (omitExpiry && c === 'expires_at') continue;
    const v = row?.[c];
    pick[c] = v instanceof Date ? v.toISOString() : (v === undefined ? null : v);
  }
  pick.__data = crypto.createHash('sha256').update(canonical(contentProjection(parseData(row) || {}))).digest('hex');
  return canonical(pick);
}

// The linked appointment the page's acceptance contract reads
// (resolveEstimateAcceptance: findLinkedUpcomingAppointment), as the state the
// document's mode and its "Confirm appointment / your appointment stays as
// scheduled" copy depend on. A cancel or reschedule changes it; an unrelated
// scheduled_services row does not (the finder returns only the linked one).
// Throws when the read fails, which the callers treat like any fence read
// failure (codex #6343 r8).
async function linkedAppointmentState(row) {
  const estimatePublic = require('../routes/estimate-public');
  const data = parseData(row) || {};
  const appointment = await estimatePublic.findLinkedUpcomingAppointment(row, data, {
    serviceModes: estimatePublic.adoptionServiceModesForContract(row, data),
  });
  if (!appointment) return null;
  const when = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  return {
    id: appointment.id,
    status: appointment.status || null,
    scheduled_date: when(appointment.scheduled_date),
    window_start: when(appointment.window_start),
    window_end: when(appointment.window_end),
    service_type: appointment.service_type || null,
    claimed: appointment.customer_id != null,
    hold: appointment.reservation_expires_at != null,
  };
}

// What the fence compares: the estimates row's content and the linked
// appointment state. Group membership is NOT part of it: a grouped estimate is
// never a valid baseline (codex #6343 r10), so handoffBlockReason refuses any
// grouped estimate outright instead of comparing against a captured verdict.
async function fullFingerprint(row, opts) {
  return `${rowFingerprint(row, opts)}|${canonical(await linkedAppointmentState(row))}`;
}

// The address an email actually goes to must still be the estimate's current
// recipient: an email correction in the estimate editor does not cancel the
// old address's queued sends, and the PDF is a permanent copy.
function sameRecipient(current, destination) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  return !!norm(current) && norm(current) === norm(destination);
}

function pastExpiry(expiry, now) {
  return !!expiry && new Date(expiry).getTime() <= now.getTime();
}

// The row-state half of the fence. A first-send follow-up needs an open
// estimate (sent / viewed) inside its expiry; the manual delivery send is
// judged on a row in its claimed 'sending' state (expiry is pinned by the send
// itself, so `delivery` skips the expiry check).
function rowStateBlock(row, { validThrough, now, delivery }) {
  if (row.archived_at) return 'estimate_not_open';
  // The delivery send holds the row in its claimed 'sending' state from the
  // claim until the provider accepts; any other status at the handoff (a
  // decline or accept landing during the render, an expiry) is not the row the
  // PDF was built from (codex #6343 r6).
  if (delivery) return row.status === 'sending' ? null : 'estimate_not_open';
  if (!['sent', 'viewed'].includes(row.status)) return 'estimate_not_open';
  return pastExpiry(validThrough || row.expires_at, now) ? 'estimate_expired' : null;
}

// The call-side half: invalidation markers and the call's verdict/linkage.
async function callSideBlock(row, data) {
  const { estimateOffCustomerSurface, callSideBlockForEstimateData } = require('../utils/estimate-claim-sql');
  if (estimateOffCustomerSurface({ estimate_data: data })) return 'estimate_invalidated';
  const callBlock = await callSideBlockForEstimateData(db, data, { estimateStatus: row.status });
  if (callBlock) return `call_side_${callBlock}`;
  const { staleCallLinkageReason } = require('./admin-estimate-persistence');
  const stale = await staleCallLinkageReason(db, data, { estimateStatus: row.status });
  return stale ? `call_linkage_${stale}` : null;
}

// Why the row may no longer go out with a PDF, or null. Same verdicts the
// manual sender repeats right before its handoff.
// `expectedFingerprint` null = skip the unchanged-since-render comparison (a
// plain "is it still sendable" read). `validThrough` is the date the document
// advertises when it is newer than the stored row (an extension in flight);
// `now` is the clock at the handoff. `delivery`: the manual delivery send.
async function handoffBlockReason(estimateId, expectedFingerprint, { validThrough = null, now = new Date(), recipient = null, delivery = false } = {}) {
  const row = await db('estimates').where({ id: estimateId }).first();
  if (!row) return 'estimate_missing';
  if (recipient && !sameRecipient(row.customer_email, recipient)) return 'recipient_changed';
  const stateBlock = rowStateBlock(row, { validThrough, now, delivery });
  if (stateBlock) return stateBlock;
  if (expectedFingerprint && (await fullFingerprint(row, { omitExpiry: delivery })) !== expectedFingerprint) return 'estimate_changed_since_render';
  // A one-property PDF must never go out for a multi-property group, whenever
  // the group formed (r6 exclusion; r9/r10 sibling unarchived mid-render).
  if (expectedFingerprint && await module.exports.estimateInMultiPropertyGroup(row)) return 'estimate_grouped';
  const data = parseData(row);
  if (data === null) return 'estimate_data_unreadable';
  return callSideBlock(row, data);
}

// sendOne awaits this after its own preparation, right before the request.
// A veto is a definite non-send (providerBoundaryBlocked); a failed read is a
// definite non-send too, tagged so the library settles it retryable.
function pdfBoundaryCheck(estimateId, expectedFingerprint, { validThrough = null, recipient = null, delivery = false, clock = () => new Date() } = {}) {
  return async () => {
    let reason;
    try {
      reason = await handoffBlockReason(estimateId, expectedFingerprint, { validThrough, recipient, delivery, now: clock() });
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
function pdfProviderHandoff(estimateId, expectedFingerprint, opts) {
  const check = pdfBoundaryCheck(estimateId, expectedFingerprint, opts);
  return async (dispatch) => {
    await dispatch(undefined, check);
    return { ok: true };
  };
}

// True when the estimate belongs to a group that has any OTHER non-archived
// member. The one definition every PDF decision uses (the review preview, the
// delivery send and the follow-ups), so they cannot disagree.
async function estimateInMultiPropertyGroup(estimate, database = db) {
  if (!estimate?.estimate_group_id) return false;
  const other = await database('estimates')
    .where({ estimate_group_id: estimate.estimate_group_id })
    .whereNot({ id: estimate.id })
    .whereNull('archived_at')
    .first('id');
  return !!other;
}

function pdfGatesOn() {
  return featureGates.isEnabled('estimateEmailPdf') && featureGates.isEnabled('estimateDocPdf');
}

// A PDF goes only on an estimate that is open right now: has its link token,
// sent or viewed, not archived, not past the date the document advertises.
function openForPdf(row, effectiveExpiry, now) {
  if (!row || !row.token) return false;
  if (!['sent', 'viewed'].includes(row.status) || row.archived_at) return false;
  return !pastExpiry(effectiveExpiry, now);
}

// `validThrough`: the date the document should advertise when the caller
// knows a newer one than the stored row (an extension in flight).
// `recipient`: the address the email is going to. When given, the PDF is built
// only if it is still the estimate's current customer_email, and the handoff
// fence repeats that check right before the request.
async function openEstimateEmailPdf({ estimateId, templateKey, validThrough = null, now = new Date(), recipient = null }) {
  try {
    if (!KEY_SET.has(templateKey) || !pdfGatesOn()) return NONE;
    const fresh = await db('estimates').where({ id: estimateId }).first();
    if (!openForPdf(fresh, validThrough || fresh?.expires_at, now)) return NONE;
    if (recipient && !sameRecipient(fresh.customer_email, recipient)) return NONE;
    // Grouped (multi-property) estimates carry no PDF copy: the shared link
    // renders the whole group but the document is one property's (r6).
    if (await estimateInMultiPropertyGroup(fresh)) return NONE;
    const pdf = require('./pdf/estimate-doc-pdf');
    // The fingerprint is of the row as the database returned it, taken before
    // anything else touches the object (the builder works on clones).
    const fingerprint = await fullFingerprint(fresh);
    const attachment = await pdf.buildEstimateEmailPdfAttachment(fresh, { validThrough: validThrough || fresh.expires_at || null });
    if (!attachment) return NONE;
    return {
      attachments: [attachment],
      // Call with the sendTemplate result: records the rate review disclosure
      // only once the provider accepted the email that carried the file.
      recordDelivered: async (result) => {
        if (result?.sent === true && result.providerAccepted === true) await pdf.recordEmailedPdfDisclosure(attachment, estimateId);
      },
      payload: { estimate_pdf_note: pdf.ESTIMATE_EMAIL_PDF_NOTES.followUp },
      // Pass to sendTemplate: the final fence for the permanent copy.
      withProviderHandoff: pdfProviderHandoff(estimateId, fingerprint, { validThrough, recipient }),
      boundaryCheck: pdfBoundaryCheck(estimateId, fingerprint, { validThrough, recipient }),
    };
  } catch (e) {
    logger.warn(`[estimate-email-pdf] skipped for estimate ${estimateId}: ${String(e?.message || e).slice(0, 200)}`);
    return NONE;
  }
}

// The manual delivery send builds its own PDF from `freshEstimate` (the row it
// just read). This hands it the same final fence the follow-ups have, bound to
// that read and to the address being sent to: a correction or content change
// between the render and the provider request vetoes the send. Returns null
// when the address being sent to is not the row's current one (no PDF should
// be built at all).
async function deliveryPdfFence(freshEstimate, { recipient, validThrough = null } = {}) {
  if (!freshEstimate?.id || !sameRecipient(freshEstimate.customer_email, recipient)) return null;
  const fingerprint = await fullFingerprint(freshEstimate, { omitExpiry: true });
  const opts = { validThrough, recipient, delivery: true };
  return {
    withProviderHandoff: pdfProviderHandoff(freshEstimate.id, fingerprint, opts),
    boundaryCheck: pdfBoundaryCheck(freshEstimate.id, fingerprint, opts),
  };
}

// The manual delivery send's whole PDF-copy step, in one place so the sender
// gains no branching (codex #6343 r8). `freshEstimate` is the row the send just
// read; `sendTo` the address the email goes to; `validThrough` the date the
// document advertises; `reviewedMessages` the reviewed/scheduled messages (a
// review with no stored PDF decision means "no PDF": an old schedule or a
// review made with the gate off, never stale).
//
// The PDF is rendered from freshEstimate but mailed to `sendTo`: a correction
// that landed in between (the email fan-out updates `sending` rows) must not
// mail a PDF of the corrected row to the old address, so it is built only when
// both are the same address, and the returned fence repeats that, the row
// fingerprint and the linked appointment at the provider boundary.
//
// Returns { expected, attachment, note, fence, warning }: `expected` is whether
// this email was meant to carry the file (so the channel result can say
// whether it did), `warning` the operator-visible text when it did not. Never
// throws: any failure means no attachment.
async function prepareDeliveryPdfCopy({ freshEstimate, sendTo, validThrough = null, reviewedMessages = null, proposalMode = false }) {
  // `annotate(channel)` stamps the operator-visible result on a successful email
  // channel; `recordDelivered()` records the rate review disclosure once the
  // provider accepted. Both are plain calls so the sender gains no branching.
  const finish = (copy) => ({
    ...copy,
    annotate: (channel) => {
      if (!copy.expected || !channel?.ok) return;
      channel.pdfAttached = !!copy.attachment;
      if (copy.warning) channel.warning = copy.warning;
    },
    recordDelivered: async () => {
      if (copy.attachment) await require('./pdf/estimate-doc-pdf').recordEmailedPdfDisclosure(copy.attachment, freshEstimate.id);
    },
  });
  const none = finish({ expected: false, attachment: null, note: '', fence: null, warning: null });
  if (proposalMode) return none;
  try {
    const reviewedAllows = !reviewedMessages || reviewedMessages.email?.pdfCopy === true;
    if (!reviewedAllows || !(await deliveryPdfCopyDecision(freshEstimate))) return none;
  } catch (e) {
    logger.warn(`[estimate-email-pdf] delivery PDF decision failed for estimate ${freshEstimate?.id}: ${String(e?.message || e).slice(0, 200)}`);
    return none;
  }
  const expected = finish({ expected: true, attachment: null, note: '', fence: null, warning: 'The PDF copy could not be attached; the email went out with the link only.' });
  try {
    const fence = await deliveryPdfFence(freshEstimate, { recipient: sendTo, validThrough });
    if (!fence) return expected;
    const pdf = require('./pdf/estimate-doc-pdf');
    const attachment = await pdf.buildEstimateEmailPdfAttachment(freshEstimate, { validThrough });
    if (!attachment) return expected;
    return finish({ expected: true, attachment, note: pdf.ESTIMATE_EMAIL_PDF_NOTES.delivery, fence, warning: null });
  } catch (e) {
    // The builder returns null on its own failures; this guards a surprise (or a
    // failed fence read) so a PDF problem can never fail the email.
    logger.warn(`[estimate-email-pdf] delivery PDF skipped for estimate ${freshEstimate?.id}: ${String(e?.message || e).slice(0, 200)}`);
    return expected;
  }
}

// Whether THIS delivery email carries the PDF copy: both gates on, not a
// commercial proposal (it keeps its own PDF path), and not a multi-property
// group (the shared link renders the whole group; the document is one
// property's). The review preview, the schedule and the send all use this one
// answer, so what was reviewed is what is sent (codex #6343 r6).
async function deliveryPdfCopyDecision(estimateRow, database = db) {
  if (!pdfGatesOn()) return false;
  if (require('./estimate-proposal').normalizeProposal(estimateRow).enabled) return false;
  // Through module.exports so a test can pin the group answer without a group fixture.
  return !(await module.exports.estimateInMultiPropertyGroup(estimateRow, database));
}

// True when a reviewed email's stored PDF decision disagrees with the current
// one. No stored decision (undefined) is never stale: it means "no PDF".
function reviewedPdfDecisionStale(reviewedMessages, currentDecision) {
  const stored = reviewedMessages?.email?.pdfCopy;
  return reviewedMessages?.email != null && stored !== undefined && stored !== currentDecision;
}

module.exports = {
  openEstimateEmailPdf,
  prepareDeliveryPdfCopy,
  deliveryPdfCopyDecision,
  reviewedPdfDecisionStale,
  estimateInMultiPropertyGroup,
  deliveryPdfFence,
  sameRecipient,
  ESTIMATE_EMAIL_PDF_TEMPLATE_KEYS,
  rowFingerprint,
  handoffBlockReason,
};
