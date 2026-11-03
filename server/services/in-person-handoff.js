/**
 * Book at the Table, estimate terms at the table (owner 2026-11-02, GATE_IN_PERSON_CARD).
 *
 * A staff accept-on-book records no acceptance terms (estimate-manual-acceptance), so
 * when staff open the in-person card step for a visit whose estimate still needs them,
 * the visit's card request is marked `in_person_terms_required`. From then on, on the
 * customer's own phone or on the owner's phone in hand-off mode alike:
 *
 *   markTermsRequired      set by POST /admin/schedule/:id/card-request/in-person.
 *   buildTermsPayload      GET /api/public/secure-card/:token adds `terms` (the terms to
 *                          tick) and `consumerNotice` (the separate-signature Florida
 *                          note for a termite estimate, informational) for a marked row.
 *                          A prepay_selected page also withholds its pay link until the
 *                          terms are recorded.
 *   recordCardPageTerms    POST /api/public/secure-card/:token/accept-terms stamps the
 *                          SAME acceptance-terms fields an online accept stamps
 *                          (method 'card_page_terms') with none of the accept's side
 *                          effects, idempotent and audited. The acceptance copy-email
 *                          sweep then mails the copy like an online accept.
 *   assertTermsRecorded    the enforcement: the card save (/complete and the Stripe
 *                          webhook backstop) and the annual-prepay choice (/select-plan)
 *                          refuse with 409 terms_required while a marked row's terms are
 *                          not recorded. Rows never marked (every texted request) are
 *                          untouched.
 *
 * Nothing here is charged or texted.
 */

const db = require('../models/db');
const logger = require('./logger');
const featureGates = require('../config/feature-gates');
const acceptanceTerms = require('./acceptance-terms-text');

const ACCEPTANCE_METHOD = 'card_page_terms';

const refusal = (status, code, error) => ({ ok: false, status, code, error });
const TERMS_CHANGED_MESSAGE = 'The terms changed. Reload this page to see them.';
const TERMS_REQUIRED_MESSAGE = 'Please accept the estimate terms first.';
const REQUEST_CLOSED_MESSAGE = 'This link is no longer open for changes. Refresh to see its current status.';

// The estimate the visit was booked from (accept-on-book stamps source_estimate_id
// on every row of the series); a later occurrence falls back to its series parent.
async function linkedEstimateFor(visitId, conn = db) {
  const visit = await conn('scheduled_services').where({ id: visitId }).first('id', 'source_estimate_id', 'recurring_parent_id');
  if (!visit) return { visit: null, estimate: null };
  let estimateId = visit.source_estimate_id || null;
  if (!estimateId && visit.recurring_parent_id) {
    const parent = await conn('scheduled_services').where({ id: visit.recurring_parent_id }).first('source_estimate_id');
    estimateId = parent?.source_estimate_id || null;
  }
  const estimate = estimateId ? await conn('estimates').where({ id: estimateId }).first() : null;
  return { visit, estimate };
}

// Mirrors the online accept's applicability check (estimate-public.js): the Florida
// notice applies while the gate is live and the estimate needs it (a termite or WDO
// line) and the customer has no signed notice on file. Independent of the
// cancel-anytime acceptance terms, which exclude exactly those estimates. An
// unreadable state shows nothing (the notice is informational here; it is signed
// on its own page).
async function consumerNoticeApplies(estimate) {
  if (!estimate || !featureGates.estimateConsumerNoticeLive()) return false;
  try {
    return await require('./estimate-consumer-notice').consumerNoticeBlocksAccept(estimate);
  } catch (err) {
    logger.warn(`[in-person-handoff] consumer notice check skipped: ${err.code || err.message}`);
    return false;
  }
}

// Null unless the estimate is accepted, has no recorded terms version, and the
// terms apply to it (the same rule the online accept uses).
async function termsContextFor(estimate) {
  if (!featureGates.isEnabled('estimateAcceptanceTerms')) return null;
  if (!estimate || estimate.status !== 'accepted' || estimate.terms_version) return null;
  const route = require('../routes/estimate-public');
  if (!route.acceptanceTermsApplyTo(estimate)) return null;
  const estData = route.parseEstimateDataSafe(estimate);
  const scope = route.acceptanceTermsScopeFor(estimate, estData, await route.buildPricingBundle(estimate));
  return { estimate, scope, noticeApplies: await consumerNoticeApplies(estimate) };
}

function estimateRefOf(estimate) {
  const slug = String(estimate.estimate_slug || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  return slug || String(estimate.id || '').split('-')[0].toUpperCase();
}

function termsPayload({ estimate, scope }) {
  return {
    estimateRef: estimateRefOf(estimate),
    version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
    scope,
    lines: acceptanceTerms.acceptanceTermsSnapshot(scope).split('\n'),
  };
}

const noticePayload = () => ({ text: require('./estimate-consumer-notice').HANDOFF_NOTICE_TEXT });

// The separate-signature Florida notice rides on its own: a termite estimate has no
// acceptance terms (they exclude it) but still needs the customer told.
async function noticeAppliesFor(estimate) {
  return estimate?.status === 'accepted' && consumerNoticeApplies(estimate);
}

// Mark the visit's pending card request as needing the estimate terms, when its
// estimate still needs them (accepted by staff, no recorded terms version, the terms
// apply) or the Florida notice. Throws on a read error, so the in-person route fails and
// the sheet can retry: an unmarked request would skip the gate.
// One compare-and-set on the row, idempotent: { marked: true } once the pending request
// carries the flag. The card save and the prepay mint carry the flag in their own claims,
// so whichever commits first wins. { marked: false, refused: true } = the terms are
// needed but the request can no longer be held: the customer already saved a card (or
// is saving one) or chose prepay on their own phone through an earlier link.
async function markTermsRequired(visitId) {
  if (!featureGates.inPersonCardLive()) return { marked: false };
  const { estimate } = await linkedEstimateFor(visitId);
  const needed = (await termsContextFor(estimate)) || (await noticeAppliesFor(estimate));
  if (!needed) return { marked: false };
  const updated = await db('appointment_card_requests')
    .where({ scheduled_service_id: visitId, kind: 'visit', status: 'pending' })
    .whereNull('prepay_invoice_id')
    .update({ in_person_terms_required: true, updated_at: new Date() });
  return updated > 0 ? { marked: true } : { marked: false, refused: true };
}

// Page states that can still save a card or pay: the terms ride on both.
const TERMS_PAGE_STATES = new Set(['ready', 'prepay_selected']);

// The `terms` and `consumerNotice` keys for GET /api/public/secure-card/:token, or
// null. Only a ready or prepay_selected page of a marked request, while the gate is
// live. `terms` leaves once recorded. The customer may have chosen prepay on their own
// phone before the office marked the request, so a prepay_selected page also withholds
// its pay link (`payUrl: null`) while the terms are outstanding.
async function buildTermsPayload({ token, data }) {
  if (!data || !TERMS_PAGE_STATES.has(data.state) || !featureGates.inPersonCardLive()) return null;
  const request = await db('appointment_card_requests').where({ token }).first('kind', 'scheduled_service_id', 'in_person_terms_required');
  if (!request || request.kind === 'customer' || !request.scheduled_service_id || !request.in_person_terms_required) return null;
  const { estimate } = await linkedEstimateFor(request.scheduled_service_id);
  const context = await termsContextFor(estimate);
  const block = {};
  if (context) {
    block.terms = termsPayload(context);
    if (data.state === 'prepay_selected') block.payUrl = null;
  }
  if (await noticeAppliesFor(estimate)) block.consumerNotice = noticePayload();
  return Object.keys(block).length ? block : null;
}

// The enforcement. null = fine; else a refusal ({ status: 409, code: 'terms_required' }).
// Applies only to a marked request while the gate is live and the estimate's terms are
// still outstanding; a read error propagates (fail closed).
async function assertTermsRecorded(request) {
  if (!request?.in_person_terms_required || !request.scheduled_service_id) return null;
  if (!featureGates.inPersonCardLive()) return null;
  const { estimate } = await linkedEstimateFor(request.scheduled_service_id);
  return (await termsContextFor(estimate)) ? refusal(409, 'terms_required', TERMS_REQUIRED_MESSAGE) : null;
}

// Stamp the acceptance terms for the marked request's estimate. Idempotent: a second
// call (or an estimate that already carries a terms version) changes nothing.
// `request` is the appointment_card_requests row the token names.
async function recordCardPageTerms({ request, termsVersion, termsScope, consumerNoticeShown, ip = null, userAgent = null }) {
  // Not a marked request: the same answer as an unknown token (no oracle).
  if (!request || request.kind === 'customer' || !request.in_person_terms_required || !featureGates.inPersonCardLive()) {
    return refusal(404, 'not_found', 'Not found');
  }
  if (request.status !== 'pending') return refusal(409, 'request_closed', REQUEST_CLOSED_MESSAGE);
  const visitId = request.scheduled_service_id;
  if (termsVersion !== acceptanceTerms.ACCEPTANCE_TERMS_VERSION) {
    // Same words as a scope change: the app relays only the message, and the
    // page offers Reload on exactly that text.
    return refusal(409, 'TERMS_VERSION_STALE', TERMS_CHANGED_MESSAGE);
  }
  // The scope the page showed ('plan' carries the annual rate review sentence, 'base'
  // does not); both share one version, so it is attested beside it, as the online
  // accept does with acceptedTermsScope.
  const shownScope = acceptanceTerms.normalizeAcceptanceTermsScope(termsScope);
  if (!shownScope) return refusal(409, 'terms_changed', TERMS_CHANGED_MESSAGE);
  const { visit, estimate } = await linkedEstimateFor(visitId);
  if (!visit) return refusal(404, 'not_found', 'Not found');
  if (!estimate || estimate.terms_version) return { ok: true, recorded: false };
  const { recordAuditEvent } = require('./audit-log');
  const acceptedAt = new Date();
  const recorded = await db.transaction(async (trx) => {
    // Locked and re-read: a second tap, or the customer's own online accept,
    // landing first leaves exactly one record. The terms are judged on THIS row.
    const locked = await trx('estimates').where({ id: estimate.id }).forUpdate().first();
    if (!locked || locked.status !== 'accepted' || locked.terms_version) return false;
    // The request and its visit, re-checked under lock: a page left open after the
    // request completed, or after the visit closed (past, cancelled, unpriced, covered
    // by a payer), records nothing. Same visit check the card save runs.
    // (The marker itself only ever goes false → true, so it needs no re-check.)
    const lockedRequest = await trx('appointment_card_requests').where({ id: request.id }).forUpdate().first();
    if (lockedRequest?.status !== 'pending') return refusal(409, 'request_closed', REQUEST_CLOSED_MESSAGE);
    const stillNeeded = await require('./appointment-card-request').secureVisitStillNeedsCard(lockedRequest, { database: trx });
    if (!stillNeeded.ok) {
      return stillNeeded.code === 'no_longer_needed'
        ? refusal(409, 'request_closed', REQUEST_CLOSED_MESSAGE)
        : refusal(503, 'try_again', 'We could not record your acceptance. Please try again.');
    }
    const context = await termsContextFor(locked);
    if (!context) return refusal(409, 'terms_not_applicable', 'No terms are needed for this estimate.');
    if (context.scope !== shownScope) return refusal(409, 'terms_changed', TERMS_CHANGED_MESSAGE);
    if (context.noticeApplies && consumerNoticeShown !== true) {
      return refusal(409, 'consumer_notice_required', 'The Florida consumer notice must be shown before the terms are accepted.');
    }
    await trx('estimate_acceptances').insert({
      estimate_id: locked.id,
      customer_id: locked.customer_id,
      method: ACCEPTANCE_METHOD,
      terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
      terms_text: acceptanceTerms.acceptanceTermsSnapshot(context.scope),
      accepted_at: acceptedAt,
      ip: ip ? String(ip).slice(0, 64) : null,
      user_agent: userAgent ? String(userAgent).slice(0, 1000) : null,
    });
    await trx('estimates').where({ id: locked.id }).update({ terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION });
    // The 'plan' drawer the customer read carried the annual rate review line, so the
    // frozen document keeps it (the same stamp the online accept writes).
    if (context.scope === 'plan') {
      await trx('estimates').where({ id: locked.id }).update({
        estimate_data: trx.raw("jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{rateReviewDisclosedAtAccept}', 'true'::jsonb)"),
      });
    }
    if (locked.customer_id) {
      // Latest version accepted on any estimate; never downgrade.
      await trx('customers').where({ id: locked.customer_id })
        .where((q) => q.whereNull('accepted_terms_version').orWhere('accepted_terms_version', '<', acceptanceTerms.ACCEPTANCE_TERMS_VERSION))
        .update({ accepted_terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION });
    }
    await recordAuditEvent({
      actor_type: 'customer',
      actor_id: request.customer_id,
      action: 'estimate.acceptance_terms.card_page',
      resource_type: 'estimate',
      resource_id: locked.id,
      metadata: {
        visit_id: visit.id,
        request_id: request.id,
        terms_version: acceptanceTerms.ACCEPTANCE_TERMS_VERSION,
        scope: context.scope,
        // A notice that applies was shown (else refused above).
        consumer_notice_shown: context.noticeApplies,
      },
      ip_address: ip,
      user_agent: userAgent,
      critical: true,
      trx,
    });
    return true;
  });
  if (recorded && recorded.ok === false) return recorded;
  return { ok: true, recorded };
}

module.exports = {
  ACCEPTANCE_METHOD,
  TERMS_REQUIRED_MESSAGE,
  markTermsRequired,
  buildTermsPayload,
  assertTermsRecorded,
  recordCardPageTerms,
};
